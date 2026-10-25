import { productService } from '../services/product.service.js';
import { categoryService } from '../services/category.service.js';
import { validate } from '../utils/validation.js';
import { createProductSchema, updateProductSchema, refurbFromSourceSchema, refurbStandaloneCreateSchema } from '../schemas/index.js';
import { toPublicJson } from '../utils/serialize.js';

/** Parse comma-separated query values (multi-select filters). */
function parseCsvQuery(value) {
  if (value == null || value === '') return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export class ProductController {
  async getAllProducts(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const rawLimit = parseInt(String(req.query.limit), 10) || 20;
    const limit = Math.min(Math.max(rawLimit, 1), 48);
    const categoryIds = parseCsvQuery(req.query.categoryId);
    const search = req.query.search ? String(req.query.search) : undefined;
    const sort = req.query.sort ? String(req.query.sort) : undefined;
    const productTypesRaw = parseCsvQuery(req.query.productType);
    const productTypes = productTypesRaw.filter((t) => t === 'NEW' || t === 'REFURBISHED');
    const minPrice = req.query.minPrice != null && req.query.minPrice !== '' ? Number(req.query.minPrice) : undefined;
    const maxPrice = req.query.maxPrice != null && req.query.maxPrice !== '' ? Number(req.query.maxPrice) : undefined;
    const sizeAgeGroup =
      req.query.sizeAgeGroup != null && String(req.query.sizeAgeGroup).trim()
        ? String(req.query.sizeAgeGroup).trim()
        : undefined;
    const ageGroups = parseCsvQuery(req.query.ageGroup);

    const listFilters = {
      search,
      sort,
      categoryIds,
      productTypes,
      minPrice: Number.isFinite(minPrice) ? minPrice : undefined,
      maxPrice: Number.isFinite(maxPrice) ? maxPrice : undefined,
      sizeAgeGroup,
      ageGroups,
    };

    const result = await productService.getAllProducts(page, limit, undefined, {
      admin: false,
      listFilters,
    });

    res.status(200).json({
      success: true,
      data: toPublicJson(result),
    });
  }

  async getRefurbSourceCandidates(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 20, 1), 100);
    const search = req.query.search ? String(req.query.search) : undefined;
    const data = await productService.getRefurbSourceCandidates({ page, limit, search });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async createRefurbFromSource(req, res) {
    const body = await validate(refurbFromSourceSchema, req.body);
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await productService.createRefurbFromSource(body, actor);
    res.status(201).json({
      success: true,
      message: data.restocked ? 'Refurb listing restocked' : 'Refurb listing created',
      data: toPublicJson(data),
    });
  }

  async createStandaloneRefurb(req, res) {
    const body = await validate(refurbStandaloneCreateSchema, req.body);
    const actor = { id: req.user?.id, email: req.user?.email };
    const product = await productService.createStandaloneRefurbProduct(body, actor);
    res.status(201).json({
      success: true,
      message: 'Standalone refurb product created',
      data: toPublicJson(product),
    });
  }

  async getAllProductsAdmin(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 20, 1), 100);
    const categoryId = req.query.categoryId ? String(req.query.categoryId) : undefined;
    const categoryIds = req.query.categoryIds ? String(req.query.categoryIds) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const sizeAgeGroup = req.query.sizeAgeGroup ? String(req.query.sizeAgeGroup) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const productType = req.query.productType ? String(req.query.productType) : undefined;
    const sort = req.query.sort ? String(req.query.sort) : undefined;

    const listFilters = {
      search,
      sizeAgeGroup,
      status,
      productType:
        productType === 'NEW' || productType === 'REFURBISHED' || productType === 'all'
          ? productType
          : undefined,
      categoryIds: categoryIds || undefined,
      sort: sort || undefined,
    };

    const statsProductType =
      productType === 'NEW' || productType === 'REFURBISHED' ? productType : 'NEW';

    const [result, stats] = await Promise.all([
      productService.getAllProducts(page, limit, categoryId, { admin: true, listFilters }),
      productService.getAdminProductStats(statsProductType),
    ]);

    res.status(200).json({
      success: true,
      data: toPublicJson({ ...result, stats }),
    });
  }

  async getProductById(req, res) {
    const { id } = req.params;
    const product = await productService.getProductById(id, { admin: false });

    res.status(200).json({
      success: true,
      data: toPublicJson(product),
    });
  }

  async getProductByIdAdmin(req, res) {
    const { id } = req.params;
    const product = await productService.getProductById(id, { admin: true });

    res.status(200).json({
      success: true,
      data: toPublicJson(product),
    });
  }

  async createProduct(req, res) {
    const data = await validate(createProductSchema, req.body);
    const product = await productService.createProduct(data);

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: toPublicJson(product),
    });
  }

  async updateProduct(req, res) {
    const { id } = req.params;
    const data = await validate(updateProductSchema, req.body);
    const product = await productService.updateProduct(id, data);

    res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      data: toPublicJson(product),
    });
  }

  async deleteProduct(req, res) {
    const { id } = req.params;
    await productService.deleteProduct(id);

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully',
    });
  }

  async getAllCategories(req, res) {
    const categories = await categoryService.getAllCategoriesPublic();
    const normalized = categories.map((category) => ({
      ...category,
      parentId: category.parent?.publicId ?? null,
      parent: undefined,
    }));

    res.status(200).json({
      success: true,
      data: toPublicJson(normalized),
    });
  }
}

export const productController = new ProductController();
