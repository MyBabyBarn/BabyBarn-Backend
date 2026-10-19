import { validate } from '../utils/validation.js';
import {
  returnRequestCreateSchema,
  returnStatusUpdateSchema,
  returnInspectLineSchema,
  returnEligibilityReviewSchema,
  refurbInspectionCreateSchema,
  returnLabelGenerateSchema,
  guestReturnCreateSchema,
  guestReturnTrackSchema,
  returnPackageRequestCreateSchema,
  returnPackageRequestUpdateSchema,
  refurbUspsShipmentSchema,
  returnCancelSchema,
  RETURN_STATUS_VALUES,
  returnReceivePackageSchema,
  returnApproveAndSettleSchema,
} from '../schemas/index.js';
import { returnsService } from '../services/returns.service.js';
import { returnPackageRequestService } from '../services/return-package-request.service.js';
import { refurbishmentService } from '../services/refurbishment.service.js';
import { toPublicJson } from '../utils/serialize.js';
import { AppError } from '../utils/error-handler.js';
import { verifyUploadedImage } from '../utils/product-upload.js';
import { z } from 'zod';

export class ReturnsController {
  async listAll(req, res) {
    const type = req.query.type ? String(req.query.type) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const statusesRaw = req.query.statuses != null ? String(req.query.statuses) : '';
    const statuses = statusesRaw
      ? statusesRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const grouped = String(req.query.grouped || '') === '1' || String(req.query.grouped || '') === 'true';
    const adminVisible =
      String(req.query.adminVisible || '') === '1' || String(req.query.adminVisible || '') === 'true';
    const page = req.query.page != null ? Number(req.query.page) : undefined;
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const search = req.query.search || req.query.q ? String(req.query.search || req.query.q) : undefined;
    const data = await returnsService.listAll({
      type,
      status,
      statuses,
      grouped,
      adminVisible,
      page,
      limit,
      search,
    });
    // Backward compatible: unpaginated callers still receive a bare array in `data`.
    if (data && typeof data === 'object' && Array.isArray(data.items) && data.pagination) {
      res.status(200).json({
        success: true,
        data: toPublicJson(data.items),
        pagination: data.pagination,
      });
      return;
    }
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getAdminListStats(req, res) {
    const data = await returnsService.getAdminListStats();
    res.status(200).json({ success: true, data });
  }

  async listMine(req, res) {
    const data = await returnsService.listForUser(req.user.id);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getMineById(req, res) {
    const data = await returnsService.getForUser(req.user.id, req.params.id);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getAdminById(req, res) {
    const data = await returnsService.getById(req.params.id);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getTriageCursor(req, res) {
    const stage = req.query.stage ? String(req.query.stage) : 'physical';
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const direction = req.query.direction ? String(req.query.direction) : 'current';
    const data = await returnsService.getTriageCursor({ stage, cursor, direction });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async create(req, res) {
    const body = await validate(returnRequestCreateSchema, req.body);
    const data = await returnsService.createForUser(req.user.id, body);
    res.status(201).json({ success: true, data: toPublicJson(data) });
  }

  async createGuest(req, res) {
    const body = await validate(guestReturnCreateSchema, req.body ?? {});
    const data = await returnsService.createForGuest(body);
    res.status(201).json({ success: true, data: toPublicJson(data) });
  }

  async updateStatus(req, res) {
    const body = await validate(returnStatusUpdateSchema, req.body);
    if (
      !body.status &&
      body.manualCarrier === undefined &&
      body.manualTrackingNumber === undefined &&
      body.manualShippedAt === undefined &&
      body.notes === undefined &&
      body.adminNotes === undefined &&
      body.inspectionChecklist === undefined
    ) {
      throw new AppError(400, 'No updates provided');
    }
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnsService.updateStatus(req.params.id, body, actor);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async inspectLine(req, res) {
    const body = await validate(returnInspectLineSchema, req.body ?? {});
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnsService.inspectLine(req.params.id, body, actor);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async receivePackage(req, res) {
    const body = await validate(returnReceivePackageSchema, req.body ?? {});
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnsService.receivePackage(req.params.id, body, actor);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async processRefund(req, res) {
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnsService.processRefund(req.params.id, actor);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async restockReturn(req, res) {
    const body = await validate(
      z.object({
        items: z
          .array(
            z.object({
              returnItemId: z.string().min(1).optional(),
              id: z.string().min(1).optional(),
              quantity: z.number().int().positive().optional(),
            })
          )
          .optional(),
      }),
      req.body ?? {}
    );
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnsService.restockReturn(req.params.id, body, actor);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async approveAndSettle(req, res) {
    const body = await validate(returnApproveAndSettleSchema, req.body ?? {});
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnsService.approveAndSettle(req.params.id, body, actor);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async trackGuest(req, res) {
    const body = await validate(guestReturnTrackSchema, req.body ?? {});
    const data = await returnsService.trackGuestReturn(body);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async createPackageRequest(req, res) {
    const body = await validate(returnPackageRequestCreateSchema, req.body);
    const data = await returnPackageRequestService.createForUser(req.user.id, body);
    res.status(201).json({ success: true, data: toPublicJson(data) });
  }

  async listPackageRequestsAdmin(req, res) {
    const status = req.query.status ? String(req.query.status) : undefined;
    const page = req.query.page != null ? Number(req.query.page) : undefined;
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const search = req.query.search || req.query.q ? String(req.query.search || req.query.q) : undefined;
    const data = await returnPackageRequestService.listForAdmin({ status, page, limit, search });
    if (data && typeof data === 'object' && Array.isArray(data.items) && data.pagination) {
      res.status(200).json({
        success: true,
        data: toPublicJson(data.items),
        pagination: data.pagination,
      });
      return;
    }
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async listPackageRequestsMine(req, res) {
    const data = await returnPackageRequestService.listForUser(req.user.id);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async updatePackageRequest(req, res) {
    const body = await validate(returnPackageRequestUpdateSchema, req.body);
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnPackageRequestService.updateStatus(req.params.id, body, actor);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async reviewEligibility(req, res) {
    const body = await validate(returnEligibilityReviewSchema, req.body);
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnsService.reviewEligibility(req.params.id, body, actor);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async generateReturnLabel(req, res) {
    const body = await validate(returnLabelGenerateSchema, req.body ?? {});
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnsService.generateReturnLabel(req.params.id, body, actor);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async syncReturnTracking(req, res) {
    const data = await returnsService.syncReturnTracking(req.params.id);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async createInspection(req, res) {
    const body = await validate(refurbInspectionCreateSchema, req.body);
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnsService.createInspectionRecord(req.params.id, body, actor);
    res.status(201).json({ success: true, data: toPublicJson(data) });
  }

  async getRefurbJobByReturn(req, res) {
    const data = await refurbishmentService.getByReturnPublicId(req.params.returnId);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async listRefurbJobs(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const status = req.query.status ? String(req.query.status) : undefined;
    const data = await refurbishmentService.listJobs({ page, status });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async updateRefurbJobStatus(req, res) {
    const body = await validate(
      z.object({
        status: z.enum([
          'RECEIVED',
          'INSPECTION',
          'CLEANING',
          'IRONING',
          'REPAIR',
          'IN_PROGRESS',
          'QA_APPROVED',
          'LISTED',
          'CANCELLED',
        ]),
        notes: z.string().optional(),
        grade: z.enum(['A', 'B', 'C']).optional(),
      }),
      req.body
    );
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await refurbishmentService.updateStatus(req.params.jobId, body.status, actor, {
      notes: body.notes,
      grade: body.grade,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async bulkMarkReceived(req, res) {
    const body = await validate(
      z.object({ returnPublicIds: z.array(z.string().min(1)).min(1).max(100) }),
      req.body
    );
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnsService.bulkMarkReceived(body.returnPublicIds, actor);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async submitUspsShipment(req, res) {
    const body = await validate(refurbUspsShipmentSchema, req.body);
    const data = await returnsService.submitCustomerUspsShipment(req.user.id, req.params.id, body);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async cancelReturn(req, res) {
    const body = await validate(returnCancelSchema, req.body ?? {});
    const data = await returnsService.cancelByUser(req.user.id, req.params.id, body);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async keepWaiting(req, res) {
    const actor = { id: req.user?.id, email: req.user?.email };
    const data = await returnsService.keepWaiting(req.params.id, actor);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  uploadPhoto(req, res) {
    const file = req.file;
    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No image file received (use field name "image").',
      });
    }
    verifyUploadedImage(file);

    const relative = `/uploads/returns/${file.filename}`;
    res.status(201).json({
      success: true,
      data: { url: relative, path: relative },
    });
  }
}

export const returnsController = new ReturnsController();
