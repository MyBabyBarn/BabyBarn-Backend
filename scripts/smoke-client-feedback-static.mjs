/**
 * Static + API smoke for Client Conversation (2) admin feedback waves.
 * Run: node scripts/smoke-client-feedback-static.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildProductSearchOr } from '../lib/product-search.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const results = [];

function check(id, claim, pass, detail = '') {
  results.push({ id, claim, pass: Boolean(pass), detail });
}

const nav = readFileSync(join(root, 'admin-fe/lib/admin-navigation.ts'), 'utf8');
const navLabels = [...nav.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
check(
  13,
  'Sidebar has no Inventory ledger / Labels & barcodes / Warehouse POS',
  !navLabels.includes('Inventory ledger') &&
    !navLabels.includes('Labels & barcodes') &&
    !navLabels.includes('Warehouse POS'),
  navLabels.filter((l) => /ledger|barcode|POS/i.test(l)).join(',') || 'none'
);

const preview = readFileSync(join(root, 'admin-fe/lib/products/storefront-preview.ts'), 'utf8');
check(5, 'Storefront preview uses /products/{slug}', preview.includes('/products/') && !preview.includes('/shop/'));

const routes = readFileSync(join(root, 'admin-fe/lib/routes.ts'), 'utf8');
check(6, 'inventoryDetail supports ?variant=', routes.includes('?variant='));

const productsRoutes = readFileSync(join(root, 'backend/routes/products.js'), 'utf8');
check(3, 'assign-category + preview routes exist', productsRoutes.includes('/assign-category') && productsRoutes.includes('/assign-category/preview'));
check(10, 'generate-skus route exists', productsRoutes.includes('/variants/generate-skus'));
check(
  11,
  'restore + soft-delete routes exist',
  productsRoutes.includes('/:id/restore') && /router\.delete\(\s*['"]\/:id['"]/.test(productsRoutes)
);

const schema = readFileSync(join(root, 'backend/prisma/schema.prisma'), 'utf8');
check(3, 'ProductCategory model exists', schema.includes('model ProductCategory'));
check(11, 'Product.deletedAt + ProductVariant.isActive', schema.includes('deletedAt') && schema.includes('isActive'));

const mig = join(root, 'backend/prisma/migrations/20261113120000_product_categories_soft_delete/migration.sql');
check(3, 'Migration file present', existsSync(mig));

const search = buildProductSearchOr('BBP-ABC');
check(
  15,
  'buildProductSearchOr matches variants + barcodes + category',
  search?.some((x) => x.variants) && search?.some((x) => x.barcodes) && search?.some((x) => x.category)
);

const counts = readFileSync(join(root, 'backend/lib/category-product-counts.js'), 'utf8');
check(2, 'getCategoryProductCounts helper exists', counts.includes('export async function getCategoryProductCounts'));

const invRoutes = readFileSync(join(root, 'backend/routes/inventory.js'), 'utf8');
check(7, 'GET /inventory/overview batch route', invRoutes.includes("'/overview'"));

const ledgerUi = readFileSync(join(root, 'admin-fe/components/admin/inventory/AdminInventoryLedgerConsole.tsx'), 'utf8');
check(14, 'Ledger New/Refurbished chips + productType filter', ledgerUi.includes('ProductTypeChip') && ledgerUi.includes("value=\"REFURBISHED\""));

const invConsole = readFileSync(join(root, 'admin-fe/components/admin/inventory/AdminInventoryConsole.tsx'), 'utf8');
check(13, 'Ledger/barcodes reachable from inventory console CTAs', invConsole.includes('/admin/inventory/ledger') && invConsole.includes('/admin/inventory/barcodes'));

const catPage = readFileSync(join(root, 'admin-fe/app/(private)/admin/(console)/categories/page.tsx'), 'utf8');
check(1, 'Category→product return context helpers wired', catPage.includes('buildProductEditHrefFromCategory'));
check(3, 'Assign conflict Move/Keep both UI', catPage.includes('Keep in both') && catPage.includes("runAssign('move')"));
check(3, 'Remove from category UI', catPage.includes('remove-category'));

const variantTable = readFileSync(join(root, 'admin-fe/components/products/VariantTable.tsx'), 'utf8');
check(10, 'VariantTable calls generate-skus when productId set', variantTable.includes('/variants/generate-skus'));

const catalog = readFileSync(join(root, 'admin-fe/components/admin/catalog/AdminProductCatalogTable.tsx'), 'utf8');
check(11, 'Catalog soft-delete + restore + deleted filter', catalog.includes('Soft-delete product') && catalog.includes('Restore product') && catalog.includes('value="deleted"'));
check(5, 'Catalog uses getStorefrontPreviewState', catalog.includes('getStorefrontPreviewState'));
check(6, 'Catalog Adjust stock uses inventoryDetail(id, variant)', catalog.includes('inventoryDetail(menuRow.id, variantId)'));
check(9, 'Catalog uses AdminMediaImage', catalog.includes('AdminMediaImage'));

const stockIn = readFileSync(join(root, 'admin-fe/components/admin/inventory/StockInDraftSession.tsx'), 'utf8');
check(16, 'Warehouse Clear uses WarehouseConfirmDialog (no window.confirm)', stockIn.includes('WarehouseConfirmDialog') && !stockIn.includes('window.confirm'));

const carousel = readFileSync(join(root, 'admin-fe/components/admin/homepage/CarouselEditor.tsx'), 'utf8');
check(12, 'Carousel delete copy is Turn off (soft-deactivate)', carousel.includes('Turn off this slide?'));

const audit = join(root, 'docs/admin-homepage-carousel-audit.md');
check(12, 'Carousel audit doc exists', existsSync(audit));

const invalidate = join(root, 'admin-fe/lib/admin/admin-invalidate.ts');
check(8, 'adminInvalidate helper exists', existsSync(invalidate));

const returnCtx = join(root, 'admin-fe/lib/admin/category-return-context.ts');
check(1, 'category-return-context module exists', existsSync(returnCtx));

let apiOk = false;
let apiDetail = '';
try {
  const res = await fetch('http://localhost:5000/health/live');
  apiOk = res.ok;
  apiDetail = `status=${res.status}`;
} catch (e) {
  apiDetail = String(e.message || e);
}
check('runtime', 'Backend /health/live responds', apiOk, apiDetail);

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} [${r.id}] ${r.claim}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
