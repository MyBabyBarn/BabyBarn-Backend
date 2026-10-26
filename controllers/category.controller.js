import { categoryService } from '../services/category.service.js';
import { validate } from '../utils/validation.js';
import {
  createCategorySchema,
  updateCategorySchema,
  categoryStatusSchema,
} from '../schemas/index.js';
import { toPublicJson } from '../utils/serialize.js';
import { writeAdminAudit } from '../services/audit.service.js';

function actorFromReq(req) {
  return {
    actorId: req.user?.publicId || req.user?.id || null,
    actorEmail: req.user?.email || null,
  };
}

export class CategoryController {
  async getTree(req, res) {
    const tree = await categoryService.getCategoryTree();
    res.status(200).json({
      success: true,
      data: toPublicJson(tree),
    });
  }

  async create(req, res) {
    const data = await validate(createCategorySchema, req.body);
    const category = await categoryService.createCategory(data);
    await writeAdminAudit({
      ...actorFromReq(req),
      action: 'category.create',
      entityType: 'Category',
      entityId: category.publicId,
      meta: { name: category.name, slug: category.slug },
    }).catch(() => {});
    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: toPublicJson(category),
    });
  }

  async update(req, res) {
    const { id } = req.params;
    const data = await validate(updateCategorySchema, req.body);
    const category = await categoryService.updateCategory(id, data);
    await writeAdminAudit({
      ...actorFromReq(req),
      action: 'category.update',
      entityType: 'Category',
      entityId: category.publicId,
      meta: { name: category.name, slug: category.slug, changes: Object.keys(data) },
    }).catch(() => {});
    res.status(200).json({
      success: true,
      message: 'Category updated successfully',
      data: toPublicJson(category),
    });
  }

  async patchStatus(req, res) {
    const { id } = req.params;
    const { isActive } = await validate(categoryStatusSchema, req.body);
    const category = await categoryService.setActive(id, isActive);
    await writeAdminAudit({
      ...actorFromReq(req),
      action: isActive ? 'category.activate' : 'category.deactivate',
      entityType: 'Category',
      entityId: category.publicId,
      meta: { isActive },
    }).catch(() => {});
    res.status(200).json({
      success: true,
      message: `Category ${isActive ? 'activated' : 'deactivated'}`,
      data: toPublicJson(category),
    });
  }

  async remove(req, res) {
    const { id } = req.params;
    await categoryService.deleteCategory(id);
    await writeAdminAudit({
      ...actorFromReq(req),
      action: 'category.delete',
      entityType: 'Category',
      entityId: id,
      meta: {},
    }).catch(() => {});
    res.status(200).json({
      success: true,
      message: 'Category deleted successfully',
    });
  }
}

export const categoryController = new CategoryController();
