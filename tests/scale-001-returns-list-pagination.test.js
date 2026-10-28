import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REFURB_ADMIN_VISIBLE_STATUSES,
  buildAdminReturnListWhere,
  buildAdminVisibleRefurbWhere,
  normalizeAdminListPagination,
} from '../lib/return-admin-list-query.js';
import { requireConsoleModuleAny } from '../middleware/admin-console.js';
import { AppError } from '../utils/error-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * In-memory ReturnRequest store that mirrors SCALE-001 list pagination semantics
 * (filter → order → group by submission → count → page).
 */
function createReturnListHarness(seedRows = []) {
  const rows = seedRows.map((r, i) => ({
    id: i + 1,
    publicId: r.publicId || `pub_${i + 1}`,
    submissionPublicId: r.submissionPublicId || `sub_${i + 1}`,
    returnNumber: r.returnNumber || null,
    type: r.type || 'STANDARD',
    status: r.status || 'REQUESTED',
    reason: r.reason || null,
    createdAt: r.createdAt || new Date(Date.UTC(2026, 0, i + 1)),
    user: r.user || { email: `u${i + 1}@ex.com`, firstName: 'U', lastName: String(i + 1) },
    order: r.order || { publicId: `ord_${i + 1}`, orderNumber: `BB-${1000 + i}` },
    orderItem: r.orderItem || { product: { name: r.productName || `Product ${i + 1}`, sku: `SKU${i}` } },
    customerShippingSubmittedAt: r.customerShippingSubmittedAt ?? null,
    manualTrackingNumber: r.manualTrackingNumber ?? null,
    orderId: r.orderId || i + 1,
  }));

  function matchesWhere(row, where) {
    if (!where || Object.keys(where).length === 0) return true;
    if (where.AND) return where.AND.every((clause) => matchesWhere(row, clause));
    if (where.OR) return where.OR.some((clause) => matchesWhere(row, clause));
    if (where.NOT) return !matchesWhere(row, where.NOT);

    for (const [key, value] of Object.entries(where)) {
      if (key === 'type') {
        if (row.type !== value) return false;
        continue;
      }
      if (key === 'status') {
        if (typeof value === 'string' && row.status !== value) return false;
        if (value?.in && !value.in.includes(row.status)) return false;
        continue;
      }
      if (key === 'customerShippingSubmittedAt' && value?.not === null) {
        if (row.customerShippingSubmittedAt == null) return false;
        continue;
      }
      if (key === 'manualTrackingNumber') {
        if (value?.not === null && (row.manualTrackingNumber == null || row.manualTrackingNumber === '')) {
          return false;
        }
        if (value?.NOT) {
          /* ignore nested NOT shape from builder companion */
        }
        continue;
      }
      if (key === 'AND' && value?.length) {
        // nested AND inside OR branch (manualTrackingNumber builder)
        if (!value.every((clause) => matchesWhere(row, clause))) return false;
        continue;
      }
      if (key === 'user') {
        for (const f of ['email', 'firstName', 'lastName']) {
          if (value?.[f]?.contains) {
            const hay = String(row.user?.[f] || '').toLowerCase();
            if (!hay.includes(String(value[f].contains).toLowerCase())) return false;
          }
        }
        continue;
      }
      if (key === 'order') {
        if (value?.orderNumber?.contains) {
          if (
            !String(row.order?.orderNumber || '')
              .toLowerCase()
              .includes(String(value.orderNumber.contains).toLowerCase())
          ) {
            return false;
          }
        }
        if (value?.publicId?.contains) {
          if (
            !String(row.order?.publicId || '')
              .toLowerCase()
              .includes(String(value.publicId.contains).toLowerCase())
          ) {
            return false;
          }
        }
        if (value?.returnPackageRequests) {
          if (!row._hasOpenPackage) return false;
        }
        continue;
      }
      if (key === 'orderItem') {
        if (value?.product?.name?.contains) {
          if (
            !String(row.orderItem?.product?.name || '')
              .toLowerCase()
              .includes(String(value.product.name.contains).toLowerCase())
          ) {
            return false;
          }
        }
        if (value?.product?.sku?.contains) {
          if (
            !String(row.orderItem?.product?.sku || '')
              .toLowerCase()
              .includes(String(value.product.sku.contains).toLowerCase())
          ) {
            return false;
          }
        }
        continue;
      }
      if (key === 'publicId' && value?.contains) {
        if (!String(row.publicId).toLowerCase().includes(String(value.contains).toLowerCase())) return false;
        continue;
      }
      if (key === 'submissionPublicId' && value?.contains) {
        if (!String(row.submissionPublicId).toLowerCase().includes(String(value.contains).toLowerCase())) {
          return false;
        }
        continue;
      }
      if (key === 'returnNumber' && value?.contains) {
        if (!String(row.returnNumber || '').toLowerCase().includes(String(value.contains).toLowerCase())) {
          return false;
        }
        continue;
      }
      if (key === 'reason' && value?.contains) {
        if (!String(row.reason || '').toLowerCase().includes(String(value.contains).toLowerCase())) return false;
        continue;
      }
    }
    return true;
  }

  function listAll(filters = {}) {
    const where = buildAdminReturnListWhere(filters);
    const { page, limit, skip, paginate } = normalizeAdminListPagination(filters);
    const matched = rows.filter((r) => matchesWhere(r, where));
    matched.sort((a, b) => {
      const dt = b.createdAt - a.createdAt;
      if (dt !== 0) return dt;
      return b.id - a.id;
    });

    if (filters.grouped) {
      const groups = new Map();
      for (const row of matched) {
        if (!groups.has(row.submissionPublicId)) groups.set(row.submissionPublicId, []);
        groups.get(row.submissionPublicId).push(row);
      }
      const submissions = [...groups.entries()]
        .map(([submissionPublicId, items]) => ({
          id: submissionPublicId,
          submissionId: submissionPublicId,
          type: items[0].type,
          status: items[0].status,
          createdAt: items.reduce(
            (min, it) => (it.createdAt < min ? it.createdAt : min),
            items[0].createdAt
          ),
          items,
        }))
        .sort((a, b) => {
          const dt = b.createdAt - a.createdAt;
          if (dt !== 0) return dt;
          return String(b.submissionId).localeCompare(String(a.submissionId));
        });

      if (!paginate) return submissions;
      const total = submissions.length;
      return {
        items: submissions.slice(skip, skip + limit),
        pagination: {
          total,
          page,
          limit,
          pages: Math.max(1, Math.ceil(total / limit) || 1),
        },
        /** Test probe: never materialize fat payloads for non-page rows */
        _scannedLineCount: matched.length,
        _returnedLineCount: submissions
          .slice(skip, skip + limit)
          .reduce((n, s) => n + s.items.length, 0),
      };
    }

    if (!paginate) return matched;
    const total = matched.length;
    return {
      items: matched.slice(skip, skip + limit),
      pagination: {
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit) || 1),
      },
    };
  }

  return { rows, listAll, matchesWhere, buildWhere: buildAdminReturnListWhere };
}

test('SCALE-001: normalizeAdminListPagination clamps page/limit', () => {
  assert.deepEqual(normalizeAdminListPagination({ page: 0, limit: 0 }), {
    page: 1,
    limit: 200,
    skip: 0,
    paginate: false,
  });
  assert.equal(normalizeAdminListPagination({ page: 2, limit: 25 }).skip, 25);
  assert.equal(normalizeAdminListPagination({ page: 1, limit: 500 }).limit, 100);
});

test('SCALE-001: list WHERE includes type + status + search (same for count)', () => {
  const where = buildAdminReturnListWhere({
    type: 'STANDARD',
    status: 'REQUESTED',
    search: 'alice',
  });
  assert.ok(where.AND);
  assert.ok(where.AND.some((c) => c.type === 'STANDARD'));
  assert.ok(where.AND.some((c) => c.status === 'REQUESTED'));
  assert.ok(where.AND.some((c) => Array.isArray(c.OR)));
});

test('SCALE-001: statuses[] becomes status.in for inspection queues', () => {
  const where = buildAdminReturnListWhere({
    type: 'REFURBISHMENT',
    statuses: ['APPROVED', 'LABEL_GENERATED'],
  });
  const statusClause = where.AND.find((c) => c.status?.in);
  assert.deepEqual(statusClause.status.in, ['APPROVED', 'LABEL_GENERATED']);
});

test('SCALE-001: adminVisible encodes refurb visibility in WHERE (not post-filter)', () => {
  const where = buildAdminVisibleRefurbWhere();
  assert.ok(where.OR.some((c) => c.status?.in?.includes('UNDER_INSPECTION')));
  assert.ok(REFURB_ADMIN_VISIBLE_STATUSES.includes('ELIGIBILITY_REVIEW'));
  const withFlag = buildAdminReturnListWhere({ type: 'REFURBISHMENT', adminVisible: true });
  assert.ok(withFlag.AND.some((c) => c.OR));
});

test('SCALE-001: page 1 / page 2 / page size / last page / empty page', () => {
  const seed = Array.from({ length: 30 }, (_, i) => ({
    submissionPublicId: `sub_${i + 1}`,
    type: 'STANDARD',
    status: 'REQUESTED',
    createdAt: new Date(Date.UTC(2026, 0, 30 - i)),
  }));
  const h = createReturnListHarness(seed);

  const p1 = h.listAll({ grouped: true, page: 1, limit: 10 });
  assert.equal(p1.items.length, 10);
  assert.equal(p1.pagination.total, 30);
  assert.equal(p1.pagination.pages, 3);

  const p2 = h.listAll({ grouped: true, page: 2, limit: 10 });
  assert.equal(p2.items.length, 10);
  assert.notEqual(p2.items[0].id, p1.items[0].id);

  const last = h.listAll({ grouped: true, page: 3, limit: 10 });
  assert.equal(last.items.length, 10);

  const empty = h.listAll({ grouped: true, page: 4, limit: 10 });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.pagination.total, 30);
});

test('SCALE-001: search + pagination share the same predicate/count', () => {
  const h = createReturnListHarness([
    { submissionPublicId: 'a', user: { email: 'alice@ex.com' }, productName: 'Onesie' },
    { submissionPublicId: 'b', user: { email: 'bob@ex.com' }, productName: 'Onesie' },
    { submissionPublicId: 'c', user: { email: 'cara@ex.com' }, productName: 'Romper' },
    { submissionPublicId: 'd', user: { email: 'dan@ex.com' }, productName: 'Hat' },
  ]);

  const where = buildAdminReturnListWhere({ search: 'alice' });
  const matched = h.rows.filter((r) => h.matchesWhere(r, where));
  assert.equal(matched.length, 1);

  const page = h.listAll({ grouped: true, page: 1, limit: 10, search: 'alice' });
  assert.equal(page.pagination.total, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, 'a');
});

test('SCALE-001: filter + pagination count invariant', () => {
  const h = createReturnListHarness([
    { submissionPublicId: '1', status: 'REQUESTED' },
    { submissionPublicId: '2', status: 'APPROVED' },
    { submissionPublicId: '3', status: 'REQUESTED' },
    { submissionPublicId: '4', status: 'REJECTED' },
    { submissionPublicId: '5', status: 'REQUESTED' },
  ]);
  const where = buildAdminReturnListWhere({ type: 'STANDARD', status: 'REQUESTED' });
  const expected = h.rows.filter((r) => h.matchesWhere(r, where)).length;
  const page = h.listAll({ grouped: true, type: 'STANDARD', status: 'REQUESTED', page: 1, limit: 2 });
  assert.equal(page.pagination.total, expected);
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((i) => i.status === 'REQUESTED'));
});

test('SCALE-001: grouped multi-line submission counts once', () => {
  const h = createReturnListHarness([
    { submissionPublicId: 'multi', publicId: 'l1', createdAt: new Date('2026-01-02') },
    { submissionPublicId: 'multi', publicId: 'l2', createdAt: new Date('2026-01-03') },
    { submissionPublicId: 'solo', publicId: 'l3', createdAt: new Date('2026-01-01') },
  ]);
  const page = h.listAll({ grouped: true, page: 1, limit: 10 });
  assert.equal(page.pagination.total, 2);
  assert.equal(page.items.length, 2);
});

test('SCALE-001: paginated grouped path only returns current page lines (scale probe)', () => {
  const seed = Array.from({ length: 50 }, (_, i) => ({
    submissionPublicId: `sub_${i + 1}`,
    createdAt: new Date(Date.UTC(2026, 0, 50 - i)),
  }));
  const h = createReturnListHarness(seed);
  const page = h.listAll({ grouped: true, page: 2, limit: 5 });
  assert.equal(page.items.length, 5);
  assert.equal(page._returnedLineCount, 5);
  assert.ok(page._returnedLineCount < page._scannedLineCount);
});

test('SCALE-001: returns/inspection module gate still 403 without module', async () => {
  const mw = requireConsoleModuleAny(['returns', 'inspection']);
  const err = await new Promise((resolve) => {
    mw({ user: { role: 'ADMIN_TEAM', adminModules: ['finance-management'] } }, {}, (e) =>
      resolve(e ?? null)
    );
  });
  assert.ok(err instanceof AppError);
  assert.equal(err.statusCode, 403);
});

test('SCALE-001: admin with returns-refurbishment passes module gate', async () => {
  const mw = requireConsoleModuleAny(['returns', 'inspection']);
  const err = await new Promise((resolve) => {
    mw({ user: { role: 'ADMIN_TEAM', adminModules: ['returns-refurbishment'] } }, {}, (e) =>
      resolve(e ?? null)
    );
  });
  assert.equal(err, null);
});

test('SCALE-001: listAll no longer slices after full fat fetch when limit set', () => {
  const serviceSrc = readFileSync(join(__dirname, '../services/returns.service.js'), 'utf8');
  assert.ok(serviceSrc.includes('returnListInclude'));
  assert.ok(serviceSrc.includes('buildAdminReturnListWhere'));
  assert.ok(serviceSrc.includes('groupBy'));
  // Old anti-pattern: fetch all then grouped.slice for pagination
  assert.equal(/grouped\.slice\(start,\s*start\s*\+\s*limit\)/.test(serviceSrc), false);
  // listAll must not post-filter adminVisible in memory
  const listAllStart = serviceSrc.indexOf('async listAll(filters = {})');
  const listAllEnd = serviceSrc.indexOf('async getAdminListStats');
  const listAllBody = serviceSrc.slice(listAllStart, listAllEnd);
  assert.equal(/isRefurbVisibleToAdmin/.test(listAllBody), false);
  assert.equal(/rows\.filter\(\(row\)\s*=>\s*\{[\s\S]*hay\.includes\(search\)/.test(listAllBody), false);
});

test('SCALE-001: admin FE returns page requests page/limit (no client slice of full set)', () => {
  const pageSrc = readFileSync(
    join(__dirname, '../../admin-fe/app/(private)/admin/(console)/returns/page.tsx'),
    'utf8'
  );
  assert.ok(pageSrc.includes("grouped: '1'"));
  assert.ok(pageSrc.includes('limit: listQuery.pageSize'));
  assert.ok(pageSrc.includes('/returns/admin/stats'));
  assert.equal(/filtered\.slice\(/.test(pageSrc), false);
});

test('SCALE-001: inspection page requests server pagination + statuses', () => {
  const pageSrc = readFileSync(
    join(__dirname, '../../admin-fe/app/(private)/admin/(console)/inspection/page.tsx'),
    'utf8'
  );
  assert.ok(pageSrc.includes("adminVisible: '1'"));
  assert.ok(pageSrc.includes('limit: listQuery.pageSize'));
  assert.ok(pageSrc.includes('params.statuses'));
  assert.equal(/filtered\.slice\(/.test(pageSrc), false);
  assert.equal(/groupQueueRows/.test(pageSrc), false);
});

test('SCALE-001: alert counts use /returns/admin/stats not full list', () => {
  const src = readFileSync(join(__dirname, '../../admin-fe/lib/hooks/use-admin-alert-counts.ts'), 'utf8');
  assert.ok(src.includes('/returns/admin/stats'));
  assert.equal(src.includes('/returns/admin/all'), false);
});
