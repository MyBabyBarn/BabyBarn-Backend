import { prisma } from '../lib/prisma.js';
import { attachDirectProductCounts } from '../lib/category-product-counts.js';
import { AppError } from '../utils/error-handler.js';

const MAX_CATEGORY_DEPTH = 4;

function slugify(text) {
  const s = String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'category';
}

async function getDepthFromRoot(categoryId) {
  let depth = 1;
  let id = categoryId;
  for (let i = 0; i < 20; i++) {
    const row = await prisma.category.findUnique({
      where: { id },
      select: { parentId: true },
    });
    if (!row?.parentId) return depth;
    depth += 1;
    id = row.parentId;
  }
  throw new AppError(500, 'Invalid category hierarchy');
}

function buildParentMap(rows) {
  const byParent = new Map();
  for (const r of rows) {
    const key = r.parentId == null ? null : r.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(r);
  }
  for (const [, list] of byParent) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return byParent;
}

function subtreeMaxDepthFromNode(byParent, nodeId) {
  const kids = byParent.get(nodeId) ?? [];
  if (kids.length === 0) return 1;
  return 1 + Math.max(...kids.map((k) => subtreeMaxDepthFromNode(byParent, k.id)));
}

async function loadAllRows() {
  const rows = await prisma.category.findMany({
    orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
  });
  return attachDirectProductCounts(rows);
}

function assertNotDescendant(rows, ancestorId, maybeDescendantId) {
  let cur = maybeDescendantId;
  const idSet = new Set(rows.map((r) => r.id));
  for (let i = 0; i < 50 && cur; i++) {
    if (cur === ancestorId) {
      throw new AppError(400, 'Cannot set parent to a descendant of this category');
    }
    const row = rows.find((r) => r.id === cur);
    cur = row?.parentId ?? null;
  }
}

export class CategoryService {
  async getAllCategoriesPublic() {
    return prisma.category.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { products: true } },
        parent: { select: { publicId: true } },
      },
    });
  }

  /** Nested tree for admin (includes inactive). */
  async getCategoryTree() {
    const rows = await loadAllRows();
    const byParent = buildParentMap(rows);
    const byId = new Set(rows.map((row) => row.id));

    const toNode = (row) => ({
      ...row,
      children: (byParent.get(row.id) ?? []).map(toNode),
    });

    const explicitRoots = byParent.get(null) ?? [];
    const orphanRoots = rows.filter((row) => row.parentId != null && !byId.has(row.parentId));
    const roots = [...explicitRoots, ...orphanRoots].sort((a, b) => a.name.localeCompare(b.name));
    return roots.map(toNode);
  }

  async getCategoryById(publicId) {
    const category = await prisma.category.findUnique({
      where: { publicId },
      include: { products: true, parent: true },
    });

    if (!category) {
      throw new AppError(404, 'Category not found');
    }

    return category;
  }

  async createCategory({ name, slug: slugInput, description, parentPublicId, isActive = true }) {
    let parentId = null;
    let parentDepth = 0;

    if (parentPublicId) {
      const parent = await prisma.category.findUnique({ where: { publicId: parentPublicId } });
      if (!parent) {
        throw new AppError(404, 'Parent category not found');
      }
      parentId = parent.id;
      parentDepth = await getDepthFromRoot(parent.id);
    }

    if (parentDepth + 1 > MAX_CATEGORY_DEPTH) {
      throw new AppError(400, `Categories can be at most ${MAX_CATEGORY_DEPTH} levels deep`);
    }

    const slug = slugInput?.trim() ? slugify(slugInput) : slugify(name);

    try {
      return await prisma.category.create({
        data: {
          name: name.trim(),
          slug,
          description: description?.trim() || null,
          parentId,
          isActive: Boolean(isActive),
        },
        include: { _count: { select: { products: true } } },
      });
    } catch (e) {
      if (e.code === 'P2002') {
        throw new AppError(400, 'A category with this name or slug already exists under the same parent');
      }
      throw e;
    }
  }

  async updateCategory(publicId, { name, slug: slugInput, description, parentPublicId, isActive }) {
    const category = await prisma.category.findUnique({ where: { publicId } });
    if (!category) {
      throw new AppError(404, 'Category not found');
    }

    const rows = await loadAllRows();
    const byParent = buildParentMap(rows);

    let nextParentId = category.parentId;
    if (parentPublicId !== undefined) {
      if (parentPublicId === null || parentPublicId === '') {
        nextParentId = null;
      } else {
        const parent = await prisma.category.findUnique({ where: { publicId: parentPublicId } });
        if (!parent) {
          throw new AppError(404, 'Parent category not found');
        }
        if (parent.id === category.id) {
          throw new AppError(400, 'Category cannot be its own parent');
        }
        assertNotDescendant(rows, category.id, parent.id);
        nextParentId = parent.id;
      }
    }

    const parentDepth =
      nextParentId == null ? 0 : await getDepthFromRoot(nextParentId);
    const relative = subtreeMaxDepthFromNode(byParent, category.id);
    if (parentDepth + relative > MAX_CATEGORY_DEPTH) {
      throw new AppError(400, `Categories can be at most ${MAX_CATEGORY_DEPTH} levels deep`);
    }

    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (slugInput !== undefined) data.slug = slugify(String(slugInput || category.slug));
    if (description !== undefined) data.description = description?.trim() || null;
    if (isActive !== undefined) data.isActive = Boolean(isActive);
    if (parentPublicId !== undefined) data.parentId = nextParentId;

    try {
      return await prisma.category.update({
        where: { id: category.id },
        data,
        include: { _count: { select: { products: true } } },
      });
    } catch (e) {
      if (e.code === 'P2002') {
        throw new AppError(400, 'A category with this name or slug already exists under the same parent');
      }
      throw e;
    }
  }

  async setActive(publicId, isActive) {
    return this.updateCategory(publicId, { isActive });
  }

  async deleteCategory(publicId) {
    const category = await prisma.category.findUnique({
      where: { publicId },
      include: {
        children: { select: { id: true } },
        productCategories: {
          where: { product: { deletedAt: null } },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!category) {
      throw new AppError(404, 'Category not found');
    }

    if (category.productCategories.length > 0) {
      throw new AppError(
        400,
        'Cannot delete a category that has products. Remove or reassign products first.'
      );
    }

    if (category.children.length > 0) {
      throw new AppError(
        400,
        'Cannot delete a category that has subcategories. Remove or move subcategories first.'
      );
    }

    await prisma.category.delete({ where: { id: category.id } });
    return { deleted: true };
  }
}

export const categoryService = new CategoryService();
