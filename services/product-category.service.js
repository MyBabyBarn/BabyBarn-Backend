import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';

/**
 * Assign products to a category with Move | Keep both semantics.
 * @param {'move'|'keepBoth'} mode
 */
export async function assignProductsToCategory({
  productPublicIds,
  categoryPublicId,
  mode = 'move',
}) {
  if (!Array.isArray(productPublicIds) || !productPublicIds.length) {
    throw new AppError(400, 'Select at least one product.');
  }
  if (mode !== 'move' && mode !== 'keepBoth') {
    throw new AppError(400, 'mode must be move or keepBoth');
  }

  const category = await prisma.category.findUnique({ where: { publicId: categoryPublicId } });
  if (!category) throw new AppError(404, 'Category not found');

  const products = await prisma.product.findMany({
    where: { publicId: { in: productPublicIds }, deletedAt: null },
    include: {
      category: { select: { id: true, publicId: true, name: true } },
      categories: { include: { category: { select: { id: true, publicId: true, name: true } } } },
    },
  });
  if (!products.length) throw new AppError(404, 'No matching products found');

  const conflicts = [];
  for (const p of products) {
    const other = (p.categories || [])
      .map((c) => c.category)
      .filter((c) => c && c.id !== category.id);
    if (other.length || (p.categoryId && p.categoryId !== category.id)) {
      const names = other.length
        ? other.map((c) => c.name)
        : p.category
          ? [p.category.name]
          : [];
      conflicts.push({
        productId: p.publicId,
        name: p.name,
        existingCategories: [...new Set(names)],
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const p of products) {
      if (mode === 'move') {
        await tx.productCategory.deleteMany({
          where: { productId: p.id, categoryId: { not: category.id } },
        });
        await tx.productCategory.upsert({
          where: { productId_categoryId: { productId: p.id, categoryId: category.id } },
          create: { productId: p.id, categoryId: category.id, isPrimary: true },
          update: { isPrimary: true },
        });
        await tx.productCategory.updateMany({
          where: { productId: p.id, categoryId: { not: category.id } },
          data: { isPrimary: false },
        });
        await tx.product.update({
          where: { id: p.id },
          data: { categoryId: category.id },
        });
      } else {
        const existingPrimary = await tx.productCategory.findFirst({
          where: { productId: p.id, isPrimary: true },
        });
        await tx.productCategory.upsert({
          where: { productId_categoryId: { productId: p.id, categoryId: category.id } },
          create: {
            productId: p.id,
            categoryId: category.id,
            isPrimary: !existingPrimary,
          },
          update: {},
        });
        if (!existingPrimary) {
          await tx.product.update({
            where: { id: p.id },
            data: { categoryId: category.id },
          });
        }
      }
    }
  });

  return {
    assigned: products.length,
    mode,
    conflictsPreview: conflicts,
  };
}

export async function removeProductFromCategory({ productPublicId, categoryPublicId }) {
  const category = await prisma.category.findUnique({ where: { publicId: categoryPublicId } });
  if (!category) throw new AppError(404, 'Category not found');
  const product = await prisma.product.findFirst({
    where: { publicId: productPublicId, deletedAt: null },
    include: { categories: true },
  });
  if (!product) throw new AppError(404, 'Product not found');

  const uncategorized = await prisma.category.findFirst({
    where: { slug: 'uncategorized', parentId: null },
  });

  await prisma.$transaction(async (tx) => {
    await tx.productCategory.deleteMany({
      where: { productId: product.id, categoryId: category.id },
    });
    const remaining = await tx.productCategory.findMany({
      where: { productId: product.id },
      orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
    });
    if (!remaining.length) {
      const fallbackId = uncategorized?.id ?? product.categoryId;
      if (uncategorized) {
        await tx.productCategory.create({
          data: { productId: product.id, categoryId: uncategorized.id, isPrimary: true },
        });
      }
      await tx.product.update({
        where: { id: product.id },
        data: { categoryId: fallbackId },
      });
    } else {
      const primary = remaining.find((r) => r.isPrimary) || remaining[0];
      await tx.productCategory.update({
        where: { id: primary.id },
        data: { isPrimary: true },
      });
      await tx.product.update({
        where: { id: product.id },
        data: { categoryId: primary.categoryId },
      });
    }
  });

  return { ok: true };
}

export async function previewAssignConflicts({ productPublicIds, categoryPublicId }) {
  const category = await prisma.category.findUnique({ where: { publicId: categoryPublicId } });
  if (!category) throw new AppError(404, 'Category not found');
  const products = await prisma.product.findMany({
    where: { publicId: { in: productPublicIds || [] }, deletedAt: null },
    include: {
      category: { select: { publicId: true, name: true } },
      categories: { include: { category: { select: { publicId: true, name: true } } } },
    },
  });
  return products
    .map((p) => {
      const others = (p.categories || [])
        .map((c) => c.category)
        .filter((c) => c && c.publicId !== category.publicId);
      const names =
        others.length > 0
          ? others.map((c) => c.name)
          : p.category && p.category.publicId !== category.publicId
            ? [p.category.name]
            : [];
      if (!names.length) return null;
      return {
        productId: p.publicId,
        name: p.name,
        existingCategories: [...new Set(names)],
      };
    })
    .filter(Boolean);
}
