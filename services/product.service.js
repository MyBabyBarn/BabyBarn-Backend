import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/error-handler.js';
import { slugifyName } from '../utils/slug.js';
import { config } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { buildProductSearchOr } from '../lib/product-search.js';

async function wishlistInterestForProducts(productIds) {
  if (!productIds.length) {
    return { wish: new Map(), moves: new Map() };
  }
  const [wishRows, moveRows] = await Promise.all([
    prisma.wishlistItem.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true, userId: true },
    }),
    prisma.wishlistCartMove.groupBy({
      by: ['productId'],
      where: { productId: { in: productIds } },
      _count: { _all: true },
    }),
  ]);
  const wish = new Map();
  for (const row of wishRows) {
    const customers = wish.get(row.productId) ?? new Set();
    customers.add(row.userId);
    wish.set(row.productId, customers);
  }
  const moves = new Map(moveRows.map((row) => [row.productId, row._count._all]));
  return { wish, moves };
}

function withWishlistInterest(product, interest) {
  return {
    ...product,
    wishlistCustomerCount: interest.wish.get(product.id)?.size ?? 0,
    wishlistCartMoveCount: interest.moves.get(product.id) ?? 0,
  };
}
import { AGE_AXIS_NAME, ageOrderIndex, isCanonicalAge } from '../lib/age-groups.js';
import {
  ensureBarcodesForProduct,
  reattachVariantBarcodes,
  snapshotVariantBarcodeSkus,
} from './barcode.service.js';

/**
 * Denormalized age list for fast PLP filtering. For variant products it is the
 * distinct canonical Age values across variant combinations; for simple products
 * it is the single sizeAgeGroup (when set). Returned in canonical display order.
 */
/**
 * Find-or-create the reserved root "Uncategorized" category used when a product
 * is saved without a category. Root-level uniqueness allows NULLs, so we query
 * by slug first and create only when missing.
 */
async function ensureUncategorizedCategory(tx) {
  const found = await tx.category.findFirst({
    where: { parentId: null, slug: 'uncategorized' },
    select: { id: true },
  });
  if (found) return found;
  return tx.category.create({
    data: { name: 'Uncategorized', slug: 'uncategorized', isActive: true },
    select: { id: true },
  });
}

function computeAgeGroups(isVariantProduct, variants, sizeAgeGroup) {
  const set = new Set();
  if (isVariantProduct && Array.isArray(variants)) {
    for (const v of variants) {
      const combo = v?.combination;
      const age = combo && typeof combo === 'object' ? combo[AGE_AXIS_NAME] : null;
      if (isCanonicalAge(age)) set.add(String(age).trim());
    }
  } else if (sizeAgeGroup && String(sizeAgeGroup).trim()) {
    set.add(String(sizeAgeGroup).trim());
  }
  return Array.from(set).sort((a, b) => ageOrderIndex(a) - ageOrderIndex(b));
}

const RELATED_REFURB_SELECT = {
  id: true,
  publicId: true,
  name: true,
  slug: true,
  price: true,
  stock: true,
  reservedStock: true,
  imageUrl: true,
  inventoryModel: true,
  isActiveListing: true,
  isDraft: true,
  updatedAt: true,
  sourceProductId: true,
  variants: {
    select: {
      publicId: true,
      sku: true,
      combination: true,
      stock: true,
      reservedStock: true,
      sortOrder: true,
    },
    orderBy: { sortOrder: 'asc' },
  },
};

function toRelatedRefurbishedPublic(row) {
  if (!row) return null;
  const variants = (row.variants ?? []).map((v) => ({
    id: v.publicId,
    sku: v.sku,
    combination: v.combination,
    stock: Math.max(0, Number(v.stock ?? 0) - Number(v.reservedStock ?? 0)),
  }));
  return {
    id: row.publicId,
    name: row.name,
    slug: row.slug,
    price: row.price,
    stock: Math.max(0, Number(row.stock ?? 0) - Number(row.reservedStock ?? 0)),
    imageUrl: row.imageUrl,
    productType: 'REFURBISHED',
    inventoryModel: row.inventoryModel ?? 'simple',
    variants,
  };
}

function toSourceProductPublic(row) {
  if (!row) return null;
  return {
    id: row.publicId,
    name: row.name,
    slug: row.slug,
    sku: row.sku,
    price: row.price,
    memberPrice: row.memberPrice,
    compareAtPrice: row.compareAtPrice,
    stock: row.stock,
    imageUrl: row.imageUrl,
    inventoryModel: row.inventoryModel,
    productType: 'NEW',
  };
}

async function pickSellableRelatedRefurbished(sourceInternalId) {
  const { productAvailableStock } = await import('./inventory-reservation.js');
  const { isSellableAvailable } = await import('../lib/inventory-stock-rules.js');
  const candidates = await prisma.product.findMany({
    where: {
      productType: 'REFURBISHED',
      sourceProductId: sourceInternalId,
      isDraft: false,
      isActiveListing: true,
      stock: { gt: 0 },
    },
    select: RELATED_REFURB_SELECT,
    orderBy: { updatedAt: 'desc' },
    take: 8,
  });
  for (const row of candidates) {
    if (isSellableAvailable(productAvailableStock(row), 'REFURBISHED')) {
      return toRelatedRefurbishedPublic(row);
    }
  }
  return null;
}

async function attachRelatedRefurbishedToProducts(products) {
  const newProducts = products.filter((p) => p.productType === 'NEW');
  if (newProducts.length === 0) {
    return products.map((p) => ({ ...p, relatedRefurbished: null }));
  }

  const { productAvailableStock } = await import('./inventory-reservation.js');
  const { isSellableAvailable } = await import('../lib/inventory-stock-rules.js');
  const sourceIds = newProducts.map((p) => p.id);
  const refurbListings = await prisma.product.findMany({
    where: {
      productType: 'REFURBISHED',
      sourceProductId: { in: sourceIds },
      isDraft: false,
      isActiveListing: true,
      stock: { gt: 0 },
    },
    select: RELATED_REFURB_SELECT,
    orderBy: { updatedAt: 'desc' },
  });

  const refurbBySource = new Map();
  for (const row of refurbListings) {
    if (!isSellableAvailable(productAvailableStock(row), 'REFURBISHED')) continue;
    if (!refurbBySource.has(row.sourceProductId)) {
      refurbBySource.set(row.sourceProductId, row);
    }
  }

  return products.map((p) => ({
    ...p,
    relatedRefurbished:
      p.productType === 'NEW' ? toRelatedRefurbishedPublic(refurbBySource.get(p.id)) : null,
    sourceProduct: p.sourceProduct
      ? {
          id: p.sourceProduct.publicId,
          name: p.sourceProduct.name,
          slug: p.sourceProduct.slug,
          sku: p.sourceProduct.sku,
          price: p.sourceProduct.price,
          memberPrice: p.sourceProduct.memberPrice,
          compareAtPrice: p.sourceProduct.compareAtPrice,
          stock: p.sourceProduct.stock,
          imageUrl: p.sourceProduct.imageUrl,
          inventoryModel: p.sourceProduct.inventoryModel,
          productType: 'NEW',
        }
      : null,
  }));
}

/** Block catalog activation until required listing fields are complete. */
function assertProductCanActivate(product, variants = product?.variants ?? []) {
  const errors = [];
  if (product.isDraft) {
    errors.push('Save and publish the product before activating the listing.');
  }
  if (!(product.name ?? '').trim()) {
    errors.push('Product title is required.');
  }
  if (product.price == null || Number(product.price) < 0 || Number.isNaN(Number(product.price))) {
    errors.push('A valid retail price is required.');
  }
  const hasImage =
    Boolean((product.imageUrl ?? '').trim()) ||
    (Array.isArray(product.gallery) && product.gallery.length > 0);
  if (!hasImage) {
    errors.push('Add at least one product image before activating.');
  }

  const isVariant =
    product.inventoryModel === 'variant_matrix' && Array.isArray(variants) && variants.length > 0;

  if (isVariant) {
    const stocked = variants.some((v) => Number(v.stock) > 0);
    if (!stocked) {
      errors.push('Assign stock to at least one variant before activating.');
    }
    const ages = computeAgeGroups(true, variants);
    if (ages.length === 0) {
      errors.push('Each variant must include a valid age group.');
    }
  } else {
    if (!(product.sizeAgeGroup ?? '').trim()) {
      errors.push('Select an age group before activating.');
    }
    if (Number(product.stock) <= 0) {
      errors.push('Set inventory stock above zero before activating.');
    }
  }

  if (errors.length > 0) {
    throw new AppError(400, errors.join(' '), 'PRODUCT_ACTIVATION_INCOMPLETE', { errors });
  }
}

function normalizeMediaUrl(url) {
  if (!url) return null;
  const u = String(url).trim();
  if (!u) return null;
  if (u.startsWith('/')) return u;

  const knownBases = [
    config.publicBaseUrl,
    `http://localhost:${config.port}`,
    `https://localhost:${config.port}`,
  ].filter(Boolean);

  for (const base of knownBases) {
    if (u.startsWith(base)) {
      const rest = u.slice(base.length);
      return rest.startsWith('/') ? rest : `/${rest}`;
    }
  }

  const match = u.match(/^https?:\/\/[^/]+(\/.*)$/);
  if (match) {
    return match[1] || '/';
  }

  return u;
}

function randomSku(prefix) {
  const hex = randomBytes(5).toString('hex').toUpperCase();
  return `${prefix}-${hex}`;
}

export async function ensureUniqueSlug(tx, base) {
  let slug = base;
  let n = 0;
  while (true) {
    const exists = await tx.product.findUnique({ where: { slug }, select: { id: true } });
    if (!exists) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

async function ensureUniqueParentSku(tx) {
  for (let i = 0; i < 20; i += 1) {
    const sku = randomSku('PARENT');
    const exists = await tx.product.findUnique({ where: { sku }, select: { id: true } });
    if (!exists) return sku;
  }
  throw new AppError(500, 'Could not allocate a unique product SKU');
}

export class ProductService {
  async getAdminProductStats(productType) {
    const typeWhere =
      productType === 'NEW' || productType === 'REFURBISHED' ? { productType } : {};
    const [total, activeListings, outOfStock] = await Promise.all([
      prisma.product.count({ where: typeWhere }),
      prisma.product.count({
        where: { ...typeWhere, isDraft: false, isActiveListing: true },
      }),
      prisma.product.count({
        where: { ...typeWhere, isDraft: false, stock: 0 },
      }),
    ]);
    return { total, activeListings, outOfStock };
  }

  /**
   * @param {object} [listFilters]
   * **Public:** `search`, `sort` (newest | price_asc | price_desc | name_asc | name_desc), `productType` / `productTypes` (comma-separated NEW,REFURBISHED), `minPrice`, `maxPrice`, `sizeAgeGroup` (exact, legacy single value), `ageGroup` / `ageGroups` (comma-separated canonical Age values, exact `in` match on `sizeAgeGroup`), `categoryId` (comma-separated public ids)
   * **Admin:** `search`, `sizeAgeGroup`, `status` (active | inactive | draft | low_stock | all)
   */
  async getAllProducts(page = 1, limit = 20, categoryPublicId, { admin = false, listFilters } = {}) {
    const skip = (page - 1) * limit;
    const { isRefurbishedEnabled } = await import('../config/feature-flags.js');
    const refurbishedEnabled = isRefurbishedEnabled();

    const parseCsv = (value) => {
      if (value == null || value === '') return [];
      if (Array.isArray(value)) return value.map(String).filter(Boolean);
      return String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    };

    const categoryPublicIds = [
      ...parseCsv(listFilters?.categoryIds),
      ...(categoryPublicId ? [String(categoryPublicId)] : []),
    ].filter((id, idx, arr) => arr.indexOf(id) === idx);

    const productTypesRaw = [
      ...parseCsv(listFilters?.productTypes),
      ...(listFilters?.productType ? [listFilters.productType] : []),
    ].filter((t) => t === 'NEW' || t === 'REFURBISHED');
    const productTypes = [...new Set(productTypesRaw)];

    if (!admin && productTypes.includes('REFURBISHED') && !refurbishedEnabled) {
      return {
        products: [],
        pagination: { total: 0, page, limit, pages: 1 },
      };
    }

    let categoryIds = [];
    if (categoryPublicIds.length > 0) {
      const categories = await prisma.category.findMany({
        where: { publicId: { in: categoryPublicIds } },
        select: { id: true, publicId: true },
      });
      if (categories.length === 0) {
        throw new AppError(404, 'Category not found');
      }
      const found = new Set(categories.map((c) => c.publicId));
      const missing = categoryPublicIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new AppError(404, 'Category not found');
      }
      categoryIds = categories.map((c) => c.id);
    }

    const where = {};
    if (categoryIds.length === 1) where.categoryId = categoryIds[0];
    else if (categoryIds.length > 1) where.categoryId = { in: categoryIds };
    if (!admin) {
      where.isDraft = false;
      where.isActiveListing = true;
      // Refurbished is one-of-one / limited: never list sold-out refurb SKUs on the storefront.
      // New products stay visible when OOS so shoppers can wishlist / request restock alerts.
      where.AND = where.AND ?? [];
      where.AND.push({
        OR: [{ productType: { not: 'REFURBISHED' } }, { stock: { gt: 0 } }],
      });
      if (listFilters) {
        const { search, minPrice, maxPrice, sizeAgeGroup } = listFilters;
        if (productTypes.length === 1) {
          where.productType = productTypes[0];
        } else if (productTypes.length > 1) {
          where.productType = { in: productTypes };
        } else if (!refurbishedEnabled) {
          where.productType = { not: 'REFURBISHED' };
        }

        const ageGroups = [
          ...parseCsv(listFilters.ageGroups),
          ...(listFilters.ageGroup ? [listFilters.ageGroup] : []),
        ].filter(Boolean);

        const ageMatch =
          ageGroups.length > 0
            ? ageGroups
            : sizeAgeGroup && String(sizeAgeGroup).trim()
              ? [String(sizeAgeGroup).trim()]
              : [];

        if (ageMatch.length > 0) {
          // Age is a variant axis (denormalized into Product.ageGroups). Match the
          // array first, falling back to the legacy single sizeAgeGroup for products
          // that predate the backfill or use the simple inventory model.
          where.AND = where.AND ?? [];
          where.AND.push({
            OR: [{ ageGroups: { hasSome: ageMatch } }, { sizeAgeGroup: { in: ageMatch } }],
          });
        }
        if (search && String(search).trim()) {
          const or = buildProductSearchOr(search);
          if (or) {
            where.AND = where.AND ?? [];
            where.AND.push({ OR: or });
          }
        }
        const pf = {};
        if (minPrice != null && Number.isFinite(Number(minPrice))) {
          pf.gte = Number(minPrice);
        }
        if (maxPrice != null && Number.isFinite(Number(maxPrice))) {
          pf.lte = Number(maxPrice);
        }
        if (Object.keys(pf).length > 0) {
          where.price = pf;
        }
      }
    } else if (listFilters) {
      const { search, sizeAgeGroup, status, productType } = listFilters;
      if (productType === 'NEW' || productType === 'REFURBISHED') {
        where.productType = productType;
      } else {
        where.productType = 'NEW';
      }
      if (sizeAgeGroup && String(sizeAgeGroup).trim()) {
        const ageValue = String(sizeAgeGroup).trim();
        where.AND = where.AND ?? [];
        where.AND.push({
          OR: [{ ageGroups: { has: ageValue } }, { sizeAgeGroup: ageValue }],
        });
      }
      const st = status && String(status).trim() ? String(status).trim() : 'all';
      if (st === 'active') {
        where.isDraft = false;
        where.isActiveListing = true;
      } else if (st === 'inactive') {
        where.isDraft = false;
        where.isActiveListing = false;
      } else if (st === 'draft') {
        where.isDraft = true;
      } else if (st === 'low_stock') {
        where.isDraft = false;
        where.stock = { gt: 0, lt: 10 };
      }
      if (search && String(search).trim()) {
        const or = buildProductSearchOr(search);
        if (or) {
          where.AND = where.AND ?? [];
          where.AND.push({ OR: or });
        }
      }
    }

    let orderBy = { updatedAt: 'desc' };
    if (!admin && listFilters?.sort) {
      const s = String(listFilters.sort);
      if (s === 'price_asc') orderBy = { price: 'asc' };
      else if (s === 'price_desc') orderBy = { price: 'desc' };
      else if (s === 'name_asc') orderBy = { name: 'asc' };
      else if (s === 'name_desc') orderBy = { name: 'desc' };
      else if (s === 'newest') orderBy = { updatedAt: 'desc' };
      else if (s === 'refurbished_newest') orderBy = { refurbishedAt: 'desc' };
    }

    const include = {
      category: true,
      sourceProduct: {
        select: {
          publicId: true,
          name: true,
          slug: true,
          sku: true,
          price: true,
          memberPrice: true,
          compareAtPrice: true,
          stock: true,
          imageUrl: true,
          inventoryModel: true,
        },
      },
      ...(admin
        ? { variants: { orderBy: { sortOrder: 'asc' } } }
        : {
            variants: {
              orderBy: { sortOrder: 'asc' },
              select: {
                publicId: true,
                sku: true,
                stock: true,
                priceOverride: true,
                memberPriceOverride: true,
                combination: true,
              },
            },
          }),
    };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include,
      }),
      prisma.product.count({ where }),
    ]);

    const interest = admin ? await wishlistInterestForProducts(products.map((product) => product.id)) : null;
    const listed = interest ? products.map((product) => withWishlistInterest(product, interest)) : products;

    const storefrontProducts =
      !admin && refurbishedEnabled
        ? await attachRelatedRefurbishedToProducts(products)
        : !admin
          ? products.map((p) => ({
              ...p,
              relatedRefurbished: null,
              sourceProduct: p.sourceProduct
                ? {
                    id: p.sourceProduct.publicId,
                    name: p.sourceProduct.name,
                    slug: p.sourceProduct.slug,
                    sku: p.sourceProduct.sku,
                    price: p.sourceProduct.price,
                    memberPrice: p.sourceProduct.memberPrice,
                    compareAtPrice: p.sourceProduct.compareAtPrice,
                    stock: p.sourceProduct.stock,
                    imageUrl: p.sourceProduct.imageUrl,
                    inventoryModel: p.sourceProduct.inventoryModel,
                    productType: 'NEW',
                  }
                : null,
            }))
          : listed;

    return {
      products: storefrontProducts,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Public storefront: resolve by URL slug first, then by publicId (legacy links).
   * Admin callers should pass publicId only.
   */
  async getProductById(identifier, { admin = false } = {}) {
    const raw = String(identifier ?? '').trim();
    if (!raw) {
      throw new AppError(404, 'Product not found');
    }

    let product = await prisma.product.findUnique({
      where: { slug: raw },
      include: {
        category: true,
        variants: { orderBy: { sortOrder: 'asc' } },
        sourceProduct: {
          select: {
            publicId: true,
            name: true,
            slug: true,
            sku: true,
            price: true,
            memberPrice: true,
            compareAtPrice: true,
            stock: true,
            imageUrl: true,
            inventoryModel: true,
          },
        },
        ...(admin
          ? {
              sourceReturn: {
                select: { publicId: true },
              },
            }
          : {}),
      },
    });

    if (!product) {
      product = await prisma.product.findUnique({
        where: { publicId: raw },
        include: {
          category: true,
          variants: { orderBy: { sortOrder: 'asc' } },
          sourceProduct: {
            select: {
              publicId: true,
              name: true,
              slug: true,
              sku: true,
              price: true,
              memberPrice: true,
              compareAtPrice: true,
              stock: true,
              imageUrl: true,
              inventoryModel: true,
            },
          },
          ...(admin
            ? {
                sourceReturn: {
                  select: { publicId: true },
                },
              }
            : {}),
        },
      });
    }

    if (!product) {
      throw new AppError(404, 'Product not found');
    }

    if (!admin && (product.isDraft || !product.isActiveListing)) {
      throw new AppError(404, 'Product not found');
    }

    const { isRefurbishedEnabled } = await import('../config/feature-flags.js');
    if (!admin && product.productType === 'REFURBISHED' && !isRefurbishedEnabled()) {
      throw new AppError(404, 'Product not found');
    }

    // Refurbished OOS still opens the PDP (marked unavailable), same as NEW.
    // Hiding via 404 made single-qty refurbs vanish mid-checkout while stock is reserved.

    if (admin) {
      const interest = await wishlistInterestForProducts([product.id]);
      return withWishlistInterest(product, interest);
    }

    let relatedRefurbished = null;
    if (product.productType === 'NEW' && isRefurbishedEnabled()) {
      relatedRefurbished = await pickSellableRelatedRefurbished(product.id);
    }

    return {
      ...product,
      relatedRefurbished,
      sourceProduct: toSourceProductPublic(product.sourceProduct),
    };
  }

  async createProduct(data, options = {}) {
    const { isRefurbishedEnabled } = await import('../config/feature-flags.js');
    const allowRefurbished = Boolean(options.allowRefurbished);
    const {
      categoryId: categoryPublicId,
      variants = [],
      slug: requestedSlug,
      gallery,
      inventoryModel = 'simple',
      sku: incomingSku,
      isDraft = false,
      variantAxes: _variantAxes,
      name,
      description,
      shortDescription,
      price,
      stock,
      imageUrl,
      memberPrice,
      compareAtPrice,
      unitPriceAmount,
      unitPriceReference,
      fabric,
      feel,
      fit,
      care,
      reorderPoint,
      sizeAgeGroup,
      vendor,
      tags,
      isActiveListing = true,
      productType = 'NEW',
    } = data;

    if (productType === 'REFURBISHED' && !allowRefurbished) {
      throw new AppError(
        400,
        'Refurbished products are created automatically when a refurb return is listed. Use the inspection queue.',
        'REFURBISHED_MANUAL_CREATE_BLOCKED'
      );
    }

    if (productType === 'REFURBISHED' && allowRefurbished && !isRefurbishedEnabled()) {
      throw new AppError(403, 'Refurbished catalog is not enabled', 'REFURBISHED_DISABLED');
    }

    let category = null;
    if (categoryPublicId) {
      category = await prisma.category.findUnique({
        where: { publicId: categoryPublicId },
        select: { id: true },
      });
      if (!category) {
        throw new AppError(404, 'Category not found');
      }
    }

    const isVariantProduct = inventoryModel === 'variant_matrix' && variants.length > 0;

    const listingActive = Boolean(isActiveListing) && !isDraft;
    if (listingActive) {
      const preview = {
        name,
        price,
        stock: isVariantProduct
          ? variants.reduce((sum, v) => sum + (v.stock ?? 0), 0)
          : stock,
        imageUrl,
        gallery,
        isDraft,
        inventoryModel: isVariantProduct ? 'variant_matrix' : inventoryModel,
        sizeAgeGroup,
      };
      assertProductCanActivate(preview, isVariantProduct ? variants : []);
    }

    const slugBase = (requestedSlug && String(requestedSlug).trim()) || slugifyName(name);
    const totalStock = isVariantProduct
      ? variants.reduce((sum, v) => sum + (v.stock ?? 0), 0)
      : stock;

    return prisma.$transaction(async (tx) => {
      const slug = await ensureUniqueSlug(tx, slugBase);
      const categoryId = category ? category.id : (await ensureUncategorizedCategory(tx)).id;

      let sku = incomingSku?.trim();
      if (isVariantProduct) {
        sku = await ensureUniqueParentSku(tx);
      } else {
        if (!sku) {
          sku = randomSku(isDraft ? 'DRAFT' : 'SKU');
          for (let i = 0; i < 20; i += 1) {
            const taken = await tx.product.findUnique({ where: { sku }, select: { id: true } });
            if (!taken) break;
            sku = randomSku(isDraft ? 'DRAFT' : 'SKU');
          }
        } else {
          const taken = await tx.product.findUnique({ where: { sku }, select: { id: true } });
          if (taken) {
            throw new AppError(400, 'Product with this SKU already exists');
          }
        }
      }

      if (isVariantProduct) {
        const seen = new Set();
        for (const v of variants) {
          if (seen.has(v.sku)) {
            throw new AppError(400, 'Duplicate variant SKU in payload');
          }
          seen.add(v.sku);
          const clash = await tx.product.findUnique({ where: { sku: v.sku }, select: { id: true } });
          if (clash) {
            throw new AppError(400, `Variant SKU "${v.sku}" conflicts with another product`);
          }
        }
      }

      const normalizedImageUrl = normalizeMediaUrl(imageUrl);

      const normalizedGallery =
        gallery === null || gallery === undefined
          ? undefined
          : Array.isArray(gallery) && gallery.length === 0
            ? Prisma.JsonNull
            : Array.isArray(gallery)
              ? gallery.map((g) => {
                  if (!g || typeof g !== 'object') return g;
                  const anyG = g;
                  if (typeof anyG.url === 'string') {
                    return { ...anyG, url: normalizeMediaUrl(anyG.url) || anyG.url };
                  }
                  return g;
                })
              : gallery;

      const product = await tx.product.create({
        data: {
          name,
          slug,
          description: description ?? null,
          shortDescription: shortDescription ?? null,
          price,
          stock: totalStock,
          categoryId,
          imageUrl: normalizedImageUrl,
          sku,
          memberPrice: memberPrice ?? null,
          compareAtPrice: compareAtPrice ?? null,
          unitPriceAmount: unitPriceAmount ?? null,
          unitPriceReference: unitPriceReference ?? null,
          fabric: fabric ?? null,
          feel: feel ?? null,
          fit: fit ?? null,
          care: care ?? null,
          reorderPoint: reorderPoint ?? null,
          sizeAgeGroup: sizeAgeGroup ?? null,
          ageGroups: computeAgeGroups(isVariantProduct, variants, sizeAgeGroup),
          vendor: vendor ?? null,
          tags: tags ?? null,
          isDraft,
          isActiveListing: listingActive,
          inventoryModel,
          productType,
          refurbishedAt: productType === 'REFURBISHED' ? new Date() : undefined,
          gallery: normalizedGallery,
          variants: isVariantProduct
            ? {
                create: variants.map((v, i) => ({
                  combination: v.combination,
                  sku: v.sku,
                  stock: v.stock,
                  priceOverride: v.priceOverride ?? null,
                  memberPriceOverride: v.memberPriceOverride ?? null,
                  imageUrl: normalizeMediaUrl(v.imageUrl),
                  sortOrder: i,
                })),
              }
            : undefined,
        },
        include: { category: true, variants: { orderBy: { sortOrder: 'asc' } } },
        });

      return product;
    }).then(async (product) => {
      try {
        await ensureBarcodesForProduct(product.id);
      } catch (err) {
        console.error('[barcode] ensure after create failed', product.id, err);
      }
      return product;
    });
  }

  async updateProduct(publicId, data) {
    const product = await prisma.product.findUnique({
      where: { publicId },
      include: {
        variants: true,
        category: { select: { publicId: true } },
      },
    });

    if (!product) {
      throw new AppError(404, 'Product not found');
    }

    const isPipelineRefurb =
      product.productType === 'REFURBISHED' &&
      product.sourceProductId != null &&
      product.sourceReturnId != null;
    const isManualLinkedRefurb =
      product.productType === 'REFURBISHED' &&
      product.sourceProductId != null &&
      product.sourceReturnId == null;
    const isSkuCategoryLockedRefurb = isPipelineRefurb || isManualLinkedRefurb;

    if (data.productType === 'REFURBISHED') {
      throw new AppError(
        400,
        'Refurbished product type cannot be set manually.',
        'REFURBISHED_MANUAL_CREATE_BLOCKED'
      );
    }

    if (isSkuCategoryLockedRefurb) {
      if (data.productType !== undefined && data.productType !== product.productType) {
        throw new AppError(400, 'Cannot change product type on a refurb listing.', 'REFURB_LOCKED');
      }
      if (data.sku !== undefined && data.sku !== product.sku) {
        throw new AppError(400, 'Cannot change SKU on a refurb listing.', 'REFURB_LOCKED');
      }
      // Category is locked for linked/pipeline refurb listings. Ignore any categoryId in
      // the payload (admin forms often re-send a cascade-rewritten id that is not a real change).
    }

    const {
      categoryId: categoryPublicId,
      variants: variantsPayload,
      variantAxes: _variantAxes,
      gallery,
      imageUrl,
      ...rest
    } = data;

    const hasVariantsKey = Object.prototype.hasOwnProperty.call(data, 'variants');
    const incomingVariants = hasVariantsKey ? variantsPayload ?? [] : null;

    const updated = await prisma.$transaction(async (tx) => {
      const updatePayload = { ...rest };

      if (isSkuCategoryLockedRefurb) {
        delete updatePayload.productType;
        delete updatePayload.sku;
        delete updatePayload.categoryId;
      }

      if (imageUrl !== undefined) {
        updatePayload.imageUrl = normalizeMediaUrl(imageUrl);
      }

      if (gallery !== undefined) {
        updatePayload.gallery =
          gallery === null || (Array.isArray(gallery) && gallery.length === 0)
            ? Prisma.JsonNull
            : Array.isArray(gallery)
              ? gallery.map((g) => {
                  if (!g || typeof g !== 'object') return g;
                  const anyG = g;
                  if (typeof anyG.url === 'string') {
                    return { ...anyG, url: normalizeMediaUrl(anyG.url) || anyG.url };
                  }
                  return g;
                })
              : gallery;
      }

      if (categoryPublicId !== undefined && !isSkuCategoryLockedRefurb) {
        const category = await tx.category.findUnique({
          where: { publicId: categoryPublicId },
          select: { id: true },
        });
        if (!category) {
          throw new AppError(404, 'Category not found');
        }
        updatePayload.categoryId = category.id;
      }

      if (updatePayload.sku !== undefined && updatePayload.sku !== null) {
        const other = await tx.product.findFirst({
          where: { sku: updatePayload.sku, NOT: { id: product.id } },
          select: { id: true },
        });
        if (other) {
          throw new AppError(400, 'Product with this SKU already exists');
        }
      }

      if (updatePayload.slug !== undefined && updatePayload.slug !== null) {
        const s = String(updatePayload.slug).trim();
        if (!s) {
          throw new AppError(400, 'Slug cannot be empty');
        }
        const otherSlug = await tx.product.findFirst({
          where: { slug: s, NOT: { id: product.id } },
          select: { id: true },
        });
        if (otherSlug) {
          throw new AppError(400, 'Product with this slug already exists');
        }
        updatePayload.slug = s;
      }

      const inv =
        data.inventoryModel !== undefined ? data.inventoryModel : product.inventoryModel;

      if (hasVariantsKey) {
        const isVariantProduct = inv === 'variant_matrix' && incomingVariants.length > 0;

        if (isPipelineRefurb && isVariantProduct) {
          if (incomingVariants.length !== product.variants.length) {
            throw new AppError(
              400,
              'Cannot add or remove variants on a pipeline refurb listing.',
              'REFURB_LOCKED'
            );
          }
          const existingBySku = new Map(product.variants.map((v) => [v.sku, v]));
          for (const incoming of incomingVariants) {
            if (!existingBySku.has(incoming.sku)) {
              throw new AppError(
                400,
                'Cannot change variant SKUs on a pipeline refurb listing.',
                'REFURB_LOCKED'
              );
            }
          }
          for (const incoming of incomingVariants) {
            const existing = existingBySku.get(incoming.sku);
            await tx.productVariant.update({
              where: { id: existing.id },
              data: {
                priceOverride: incoming.priceOverride ?? null,
                memberPriceOverride: incoming.memberPriceOverride ?? null,
                imageUrl: normalizeMediaUrl(incoming.imageUrl),
              },
            });
          }
          delete updatePayload.stock;
          updatePayload.ageGroups = computeAgeGroups(true, product.variants);
          return tx.product.update({
            where: { id: product.id },
            data: updatePayload,
            include: { category: true, variants: { orderBy: { sortOrder: 'asc' } } },
          });
        }

        const barcodeSkuSnapshot = await snapshotVariantBarcodeSkus(tx, product.id);
        await tx.productVariant.deleteMany({ where: { productId: product.id } });

        if (isVariantProduct) {
          const seen = new Set();
          for (const v of incomingVariants) {
            if (seen.has(v.sku)) {
              throw new AppError(400, 'Duplicate variant SKU in payload');
            }
            seen.add(v.sku);
            const clash = await tx.product.findFirst({
              where: { sku: v.sku, NOT: { id: product.id } },
              select: { id: true },
            });
            if (clash) {
              throw new AppError(400, `Variant SKU "${v.sku}" conflicts with another product`);
            }
          }

          const wasVariant =
            product.inventoryModel === 'variant_matrix' && product.variants.length > 0;

          updatePayload.stock = incomingVariants.reduce((sum, v) => sum + v.stock, 0);
          updatePayload.inventoryModel = 'variant_matrix';
          updatePayload.ageGroups = computeAgeGroups(true, incomingVariants);

          if (!wasVariant) {
            updatePayload.sku = await ensureUniqueParentSku(tx);
          }

          const next = await tx.product.update({
            where: { id: product.id },
            data: {
              ...updatePayload,
              variants: {
                create: incomingVariants.map((v, i) => ({
                  combination: v.combination,
                  sku: v.sku,
                  stock: v.stock,
                  priceOverride: v.priceOverride ?? null,
                  memberPriceOverride: v.memberPriceOverride ?? null,
                  imageUrl: normalizeMediaUrl(v.imageUrl),
                  sortOrder: i,
                })),
              },
            },
            include: { category: true, variants: { orderBy: { sortOrder: 'asc' } } },
          });
          await reattachVariantBarcodes(tx, product.id, barcodeSkuSnapshot);
          return next;
        }

        updatePayload.inventoryModel = 'simple';
        if (data.stock !== undefined) {
          updatePayload.stock = data.stock;
        }
        updatePayload.ageGroups = computeAgeGroups(
          false,
          [],
          updatePayload.sizeAgeGroup !== undefined ? updatePayload.sizeAgeGroup : product.sizeAgeGroup
        );

        return tx.product.update({
          where: { id: product.id },
          data: updatePayload,
          include: { category: true, variants: { orderBy: { sortOrder: 'asc' } } },
        });
      }

      const existingIsVariant =
        product.inventoryModel === 'variant_matrix' && product.variants.length > 0;
      updatePayload.ageGroups = existingIsVariant
        ? computeAgeGroups(true, product.variants)
        : computeAgeGroups(
            false,
            [],
            updatePayload.sizeAgeGroup !== undefined
              ? updatePayload.sizeAgeGroup
              : product.sizeAgeGroup
          );

      if (updatePayload.isActiveListing === true && product.isActiveListing !== true) {
        const preview = { ...product, ...updatePayload };
        const variantRows =
          hasVariantsKey && incomingVariants !== null ? incomingVariants : product.variants;
        assertProductCanActivate(preview, variantRows);
      }

      return tx.product.update({
        where: { id: product.id },
        data: updatePayload,
        include: { category: true, variants: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    try {
      await ensureBarcodesForProduct(updated.id);
    } catch (err) {
      console.error('[barcode] ensure after update failed', updated.id, err);
    }

    const { productAvailableStock } = await import('./inventory-reservation.js');
    const { isSellableAvailable } = await import('../lib/inventory-stock-rules.js');
    const beforeAvailable = productAvailableStock(product);
    const afterAvailable = productAvailableStock(updated);
    if (
      updated.productType === 'NEW' &&
      !isSellableAvailable(beforeAvailable, 'NEW') &&
      isSellableAvailable(afterAvailable, 'NEW')
    ) {
      import('./stock-alert.service.js')
        .then(({ notifyProductBackInStock }) => notifyProductBackInStock(updated.id))
        .catch((err) => console.error('[products] back-in-stock notify failed', err));
    }

    return updated;
  }

  async assertRefurbFeatureEnabled() {
    const { isRefurbishedEnabled } = await import('../config/feature-flags.js');
    if (!isRefurbishedEnabled()) {
      throw new AppError(403, 'Refurbished catalog is not enabled', 'REFURBISHED_DISABLED');
    }
  }

  async getRefurbSourceCandidates({ page = 1, limit = 20, search } = {}) {
    await this.assertRefurbFeatureEnabled();
    const take = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
    const where = {
      productType: 'NEW',
      isActiveListing: true,
      isDraft: false,
    };
    const or = buildProductSearchOr(search, { includeDescription: false });
    if (or) {
      where.OR = or;
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
        include: {
          category: { select: { publicId: true, name: true } },
          variants: {
            select: { publicId: true, sku: true, combination: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      }),
      prisma.product.count({ where }),
    ]);

    const sourceIds = products.map((p) => p.id);
    const refurbListings =
      sourceIds.length > 0
        ? await prisma.product.findMany({
            where: {
              productType: 'REFURBISHED',
              sourceProductId: { in: sourceIds },
            },
            select: {
              publicId: true,
              sourceProductId: true,
              stock: true,
              sku: true,
              isActiveListing: true,
              isDraft: true,
              updatedAt: true,
            },
            orderBy: { updatedAt: 'desc' },
          })
        : [];
    // Prefer active listing; otherwise any draft/inactive shell for this source.
    const refurbBySource = new Map();
    for (const r of refurbListings) {
      const prev = refurbBySource.get(r.sourceProductId);
      if (!prev) {
        refurbBySource.set(r.sourceProductId, r);
        continue;
      }
      const prevActive = prev.isActiveListing && !prev.isDraft;
      const nextActive = r.isActiveListing && !r.isDraft;
      if (nextActive && !prevActive) refurbBySource.set(r.sourceProductId, r);
    }

    return {
      items: products.map((p) => {
        const refurb = refurbBySource.get(p.id);
        return {
          id: p.publicId,
          name: p.name,
          sku: p.sku,
          stock: p.stock,
          imageUrl: p.imageUrl,
          inventoryModel: p.inventoryModel,
          category: p.category ? { id: p.category.publicId, name: p.category.name } : null,
          variants: p.variants.map((v) => ({
            id: v.publicId,
            sku: v.sku,
            combination: v.combination,
          })),
          hasActiveRefurbListing: Boolean(refurb),
          refurbListingId: refurb?.publicId ?? null,
          refurbListingSku: refurb?.sku ?? null,
          refurbListingStock: refurb?.stock ?? null,
        };
      }),
      pagination: {
        page: Math.max(Number(page) || 1, 1),
        limit: take,
        total,
        pages: Math.ceil(total / take) || 1,
      },
    };
  }

  async createRefurbFromSource(payload, actor) {
    await this.assertRefurbFeatureEnabled();
    const { resolveActorUserId } = await import('../lib/resolve-actor-user-id.js');
    const { listOrRestockRefurbForSource } = await import('./refurb-product-listing.service.js');
    const { writeAdminAudit } = await import('./audit.service.js');

    const actorUserId = await resolveActorUserId(actor);
    const result = await listOrRestockRefurbForSource({
      sourceProductPublicId: payload.sourceProductId,
      sourceVariantPublicId: payload.sourceVariantId,
      initialStock: payload.initialStock ?? 1,
      conditionGrade: payload.conditionGrade ?? null,
      createAsDraft: payload.createAsDraft === true,
      actorUserId,
      ledgerReference: {
        type: 'manual_refurb',
        id: payload.sourceProductId,
        note: 'Manual refurb from source',
      },
    });

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'REFURB_MANUAL_FROM_SOURCE',
      entityType: 'Product',
      entityId: result.product.publicId,
      meta: {
        sourceProductId: payload.sourceProductId,
        restocked: result.restocked,
        initialStock: payload.initialStock ?? 1,
      },
    });

    return result;
  }

  async createStandaloneRefurbProduct(data, actor) {
    await this.assertRefurbFeatureEnabled();
    const { writeAdminAudit } = await import('./audit.service.js');
    const product = await this.createProduct(
      { ...data, productType: 'REFURBISHED' },
      { allowRefurbished: true }
    );

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'REFURB_MANUAL_STANDALONE',
      entityType: 'Product',
      entityId: product.publicId,
      meta: { sku: product.sku, name: product.name },
    });

    return product;
  }

  async deleteProduct(publicId) {
    const product = await prisma.product.findUnique({ where: { publicId } });

    if (!product) {
      throw new AppError(404, 'Product not found');
    }

    return prisma.product.delete({ where: { id: product.id } });
  }
}

export const productService = new ProductService();
