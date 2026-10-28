import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { ensureBarcode } from '../services/barcode.service.js';
import { receiveOrAdd, verifyCount, resolveScan } from '../services/inventory-scan.service.js';

async function seedSimpleProduct() {
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) throw new Error('Need at least one category');
  const stamp = Date.now();
  return prisma.product.create({
    data: {
      name: 'Scan gate',
      slug: `scan-gate-${stamp}`,
      price: 12,
      stock: 4,
      reservedStock: 0,
      sku: `SC-${stamp}`,
      categoryId: category.id,
      inventoryModel: 'simple',
    },
  });
}

test('scan resolve rejects unknown codes; receive/verify follow stock rules', {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const product = await seedSimpleProduct();
  try {
    await assert.rejects(
      () => resolveScan('BBP-00000000'),
      (err) => err instanceof AppError && err.statusCode === 404
    );

    const barcode = await ensureBarcode({ productId: product.id, variantId: null });
    const admin = await prisma.user.findFirst({
      where: { email: { equals: 'admin@babyburn.local', mode: 'insensitive' } },
      select: { publicId: true, email: true },
    });
    if (!admin) throw new Error('Need seed admin@babyburn.local for scan test');
    const actor = { id: admin.publicId, email: admin.email };

    await assert.rejects(
      () => receiveOrAdd({ code: barcode.code, mode: 'bulk', quantity: 2, reason: '', actor, kind: 'add' }),
      (err) => err instanceof AppError && err.statusCode === 400
    );

    const added = await receiveOrAdd({
      code: barcode.code,
      mode: 'bulk',
      quantity: 2,
      reason: 'New Inventory',
      actor,
      kind: 'add',
    });
    assert.equal(added.product.onHand, 6);

    const flagged = await verifyCount({
      code: barcode.code,
      counted: 4,
      applyAdjustment: false,
      actor,
    });
    assert.equal(flagged.mismatch, true);
    assert.equal(flagged.adjusted, false);
    assert.equal(flagged.onHand, 6);

    const corrected = await verifyCount({
      code: barcode.code,
      counted: 4,
      applyAdjustment: true,
      actor,
    });
    assert.equal(corrected.adjusted, true);
    assert.equal(corrected.product.onHand, 4);
  } finally {
    await prisma.product.delete({ where: { id: product.id } }).catch(() => undefined);
  }
});
