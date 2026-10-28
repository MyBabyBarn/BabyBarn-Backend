import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProductSearchOr } from '../lib/product-search.js';
import { publicCache } from '../middleware/public-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('SCL-03: product search prefers prefix and gates description scans', () => {
  assert.equal(buildProductSearchOr(''), null);
  assert.equal(buildProductSearchOr('  '), null);
  const short = buildProductSearchOr('a');
  assert.deepEqual(short, [{ sku: { equals: 'a', mode: 'insensitive' } }]);

  const mid = buildProductSearchOr('tee');
  assert.ok(mid.some((c) => c.name?.startsWith));
  assert.ok(!mid.some((c) => c.description));

  const long = buildProductSearchOr('onesie');
  assert.ok(long.some((c) => c.description?.contains === 'onesie'));

  const noDesc = buildProductSearchOr('onesie', { includeDescription: false });
  assert.ok(!noDesc.some((c) => c.description));

  const schema = readFileSync(join(__dirname, '../prisma/schema.prisma'), 'utf8');
  assert.match(schema, /@@index\(\[name\]\)/);
});

test('SCL-01: publicCache sets public Cache-Control for anonymous GETs', () => {
  const mw = publicCache(60);
  const headers = {};
  const res = { setHeader(k, v) { headers[k] = v; } };
  let nextCalled = false;
  mw({ method: 'GET', get: () => undefined }, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.match(headers['Cache-Control'], /public, max-age=60/);

  const privateHeaders = {};
  const privateRes = { setHeader(k, v) { privateHeaders[k] = v; } };
  mw({ method: 'GET', get: (h) => (h === 'authorization' ? 'Bearer x' : undefined) }, privateRes, () => {});
  assert.equal(privateHeaders['Cache-Control'], 'private, no-store');
});

test('OPS-01: deploy workflow runs npm test before EC2 deploy', () => {
  const deploy = readFileSync(join(__dirname, '../.github/workflows/deploy-ec2.yml'), 'utf8');
  assert.match(deploy, /npm test/);
  assert.match(deploy, /needs: ci/);
});

test('DEP-03: nodemailer is on a patched major and qs is overridden', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
  assert.match(String(pkg.dependencies.nodemailer), /^(\^|~)?10\./);
  assert.equal(pkg.overrides?.qs, '^6.16.1');
});
