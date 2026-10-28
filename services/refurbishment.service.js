import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { writeAdminAudit } from './audit.service.js';
import { resolveActorUserId } from '../lib/resolve-actor-user-id.js';
import { listOrRestockRefurbForSourceInTx } from './refurb-product-listing.service.js';

const TRANSITIONS = {
  RECEIVED: ['INSPECTION', 'CANCELLED'],
  INSPECTION: ['CLEANING', 'IN_PROGRESS', 'CANCELLED'],
  CLEANING: ['IRONING', 'REPAIR', 'IN_PROGRESS', 'CANCELLED'],
  IRONING: ['REPAIR', 'IN_PROGRESS', 'QA_APPROVED', 'CANCELLED'],
  REPAIR: ['IN_PROGRESS', 'QA_APPROVED', 'CANCELLED'],
  IN_PROGRESS: ['QA_APPROVED', 'CANCELLED'],
  QA_APPROVED: ['LISTED', 'CANCELLED'],
  LISTED: [],
  CANCELLED: [],
};

const UNIT_STATUS_BY_JOB = {
  INSPECTION: 'INSPECTION',
  CLEANING: 'REFURBISHING',
  IRONING: 'REFURBISHING',
  REPAIR: 'REFURBISHING',
  IN_PROGRESS: 'REFURBISHING',
  QA_APPROVED: 'QA_HOLD',
  LISTED: 'AVAILABLE_REFURB',
};

export class RefurbishmentService {
  validateTransition(current, next) {
    return (TRANSITIONS[current] || []).includes(next);
  }

  async getByReturnPublicId(returnPublicId) {
    const rr = await prisma.returnRequest.findUnique({
      where: { publicId: returnPublicId },
      select: { id: true },
    });
    if (!rr) throw new AppError(404, 'Return not found');
    return prisma.refurbishmentJob.findUnique({
      where: { returnRequestId: rr.id },
      include: {
        returnRequest: {
          include: {
            orderItem: { include: { product: true } },
            user: { select: { email: true, firstName: true, lastName: true } },
            inspectionRecords: { orderBy: { createdAt: 'desc' }, take: 5 },
          },
        },
        listedProduct: {
          select: {
            publicId: true,
            name: true,
            slug: true,
            stock: true,
            sku: true,
            conditionGrade: true,
            sourceProductId: true,
          },
        },
        inspectionRecords: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });
  }

  async listJobs({ status, page = 1, limit = 24 }) {
    const skip = (page - 1) * limit;
    const where = status && status !== 'all' ? { status } : {};
    const [rows, total] = await Promise.all([
      prisma.refurbishmentJob.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          returnRequest: {
            include: {
              orderItem: { include: { product: { select: { name: true, sku: true, publicId: true } } } },
              user: { select: { email: true, firstName: true, lastName: true } },
            },
          },
          listedProduct: { select: { publicId: true, name: true, sku: true, stock: true } },
        },
      }),
      prisma.refurbishmentJob.count({ where }),
    ]);
    return {
      jobs: rows,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    };
  }

  async createJobForReturn(returnRequestId) {
    const existing = await prisma.refurbishmentJob.findUnique({ where: { returnRequestId } });
    if (existing) return existing;
    return prisma.refurbishmentJob.create({
      data: { returnRequestId, status: 'RECEIVED' },
    });
  }

  async transitionUnitsForJob(job, nextStatus) {
    const unitStatus = UNIT_STATUS_BY_JOB[nextStatus];
    if (!unitStatus) return;
    const units = await prisma.productUnit.findMany({
      where: { sourceReturnId: job.returnRequestId },
    });
    for (const unit of units) {
      if (unit.status === unitStatus) continue;
      await prisma.productUnit.update({
        where: { id: unit.id },
        data: {
          status: unitStatus,
          inspectedAt: nextStatus === 'INSPECTION' ? new Date() : unit.inspectedAt,
          refurbishedAt: ['CLEANING', 'IRONING', 'REPAIR', 'IN_PROGRESS'].includes(nextStatus)
            ? new Date()
            : unit.refurbishedAt,
          relistedAt: nextStatus === 'LISTED' ? new Date() : unit.relistedAt,
        },
      });
      await prisma.productUnitEvent.create({
        data: {
          unitId: unit.id,
          fromStatus: unit.status,
          toStatus: unitStatus,
          note: `Refurb job ${nextStatus}`,
        },
      });
    }
  }

  async updateStatus(jobPublicId, nextStatus, actor, opts = {}) {
    const job = await prisma.refurbishmentJob.findUnique({
      where: { publicId: jobPublicId },
      include: {
        returnRequest: {
          include: {
            orderItem: { include: { product: true, productVariant: true } },
            user: true,
            inspectionRecords: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });
    if (!job) throw new AppError(404, 'Refurbishment job not found');
    if (!this.validateTransition(job.status, nextStatus)) {
      throw new AppError(400, `Invalid transition: ${job.status} -> ${nextStatus}`);
    }

    const data = { status: nextStatus };
    const now = new Date();
    if (nextStatus === 'INSPECTION') data.inspectedAt = now;
    if (['CLEANING', 'IRONING', 'REPAIR', 'IN_PROGRESS'].includes(nextStatus)) data.refurbishedAt = now;

    let listedProduct = null;
    const actorInternalId = await resolveActorUserId(actor);
    if (nextStatus === 'LISTED') {
      // FMA-04: membership must still be active when the item is refurbished / listed.
      const memberUntil = job.returnRequest?.user?.accessMemberUntil;
      const membershipActive = Boolean(memberUntil && new Date(memberUntil) > new Date());
      if (!membershipActive) {
        throw new AppError(
          403,
          'Farmhouse Friends membership is required to list a refurbished item. The customer membership is no longer active.',
          'REFURB_MEMBERSHIP_REQUIRED'
        );
      }
      listedProduct = await this.createListedRefurbProduct(job, actorInternalId);
      data.listedAt = now;
      data.listedProductId = listedProduct.id;
    }

    if (opts.notes !== undefined) data.notes = opts.notes ? String(opts.notes).trim() : null;

    const updated = await prisma.refurbishmentJob.update({
      where: { id: job.id },
      data,
      include: { listedProduct: true },
    });

    await this.transitionUnitsForJob(job, nextStatus);

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'REFURB_JOB_STATUS',
      entityType: 'RefurbishmentJob',
      entityId: jobPublicId,
      meta: { from: job.status, to: nextStatus },
    });

    return { job: updated, listedProduct: updated.listedProduct || listedProduct };
  }

  async createListedRefurbProduct(job, actorUserId = null) {
    const line = job.returnRequest.orderItem;
    const source = line?.product;
    if (!source) throw new AppError(400, 'Return has no product line to list');

    return prisma.$transaction(async (tx) => {
      const sourceFull = await tx.product.findUnique({
        where: { id: source.id },
        include: { variants: { orderBy: { sortOrder: 'asc' } } },
      });
      const { product } = await listOrRestockRefurbForSourceInTx(tx, {
        sourceFull,
        sourceVariantId: line?.productVariantId ?? null,
        linePrice: line?.price ?? null,
        initialStock: 1,
        conditionGrade: null,
        sourceReturnId: job.returnRequestId,
        actorUserId,
        unitReturnRequestId: job.returnRequestId,
        ledgerReference: {
          type: 'refurbishment_job',
          id: job.publicId,
          note: 'Refurbished unit listed',
        },
      });
      return product;
    });
  }
}

export const refurbishmentService = new RefurbishmentService();
