import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import {
  ensureBarcode,
  ensureBarcodesForProduct,
  lookup,
  markSent,
  regenerate,
} from '../services/barcode.service.js';

async function seedProduct() {
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) throw new Error('Need at least one category to run barcode identity test');
  const stamp = Date.now();
  return prisma.product.create({
    data: {
      name: 'Barcode gate',
      slug: `barcode-gate-${stamp}`,
      price: 10,
      stock: 5,
      sku: `BC-PARENT-${stamp}`,
      categoryId: category.id,
      inventoryModel: 'variant_matrix',
      variants: {
        create: [
          { combination: { Size: 'S' }, sku: `BC-${stamp}-S`, stock: 2, sortOrder: 0 },
          { combination: { Size: 'M' }, sku: `BC-${stamp}-M`, stock: 3, sortOrder: 1 },
        ],
      },
    },
    include: { variants: true },
  });
}

test('barcode identity survives SKU/name/price change; two variants two codes', {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const product = await seedProduct();
  try {
    const rows = await ensureBarcodesForProduct(product.id);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].code, rows[1].code);

    const first = rows[0];
    const variantId = first.productVariantId;
    const oldSku = first.productVariant.sku;
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { sku: `${oldSku}-RENAMED` },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { name: 'Renamed garment', price: 99 },
    });

    const found = await lookup(first.code);
    assert.equal(found.code, first.code);
    assert.equal(found.product.name, 'Renamed garment');
    assert.equal(found.variant.sku, `${oldSku}-RENAMED`);
    assert.equal(found.product.price, 99);

    const again = await ensureBarcode({ productId: product.id, variantId });
    assert.equal(again.code, first.code);

    await markSent(first.code, { id: 'test', email: 'barcode@test.local' });
    const afterSent = await ensureBarcode({ productId: product.id, variantId });
    assert.equal(afterSent.code, first.code);
    assert.ok(afterSent.sentToVendorAt);

    const bySku = await lookup(`${oldSku}-RENAMED`);
    assert.equal(bySku.code, first.code);

    await assert.rejects(
      () => regenerate(first.code, { actor: { id: 'test', email: 'barcode@test.local' } }),
      (err) => err instanceof AppError && err.statusCode === 409
    );
    const regen = await regenerate(first.code, {
      confirmSent: true,
      actor: { id: 'test', email: 'barcode@test.local' },
    });
    assert.notEqual(regen.code, first.code);
    const oldStillWorks = await lookup(first.code);
    assert.equal(oldStillWorks.code, regen.code);

    await assert.rejects(
      () => lookup('BBP-00000000'),
      (err) => err instanceof AppError && err.statusCode === 404
    );
  } finally {
    await prisma.product.delete({ where: { id: product.id } }).catch(() => undefined);
  }
});
