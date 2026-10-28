import { z } from 'zod';
import { validate } from '../utils/validation.js';
import { toPublicJson } from '../utils/serialize.js';
import * as shippingAdmin from '../services/shipping-admin.service.js';

const providerUpdateSchema = z.object({
  slug: z.string().min(1),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  displayName: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
  credentials: z
    .object({
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      accountNumber: z.string().optional(),
      baseUrl: z.string().optional(),
    })
    .optional(),
});

const putShippingConfigSchema = z
  .object({
    providers: z.array(providerUpdateSchema).optional(),
    platform: z
      .object({
        pickupAddressJson: z.any().optional().nullable(),
        defaultPackageJson: z.any().optional().nullable(),
        autoLabelGeneration: z.boolean().optional(),
        manualShippingAllowed: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((d) => (d.providers && d.providers.length > 0) || d.platform, {
    message: 'Provide at least one of: providers (non-empty) or platform settings',
  });

const patchServiceSchema = z.object({
  displayName: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  visibleAtCheckout: z.boolean().optional(),
  visibleInAdmin: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const createServiceSchema = z.object({
  providerSlug: z.string().min(1),
  code: z.string().min(1).max(40),
  displayName: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  visibleAtCheckout: z.boolean().optional(),
  visibleInAdmin: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const testUpsSchema = z
  .object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    accountNumber: z.string().optional(),
    baseUrl: z.string().optional(),
  })
  .optional();

export class ShippingAdminController {
  async getConfig(req, res) {
    const data = await shippingAdmin.adminGetShippingConfig();
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async putConfig(req, res) {
    const body = await validate(putShippingConfigSchema, req.body ?? {});
    if (body.providers?.length) {
      await shippingAdmin.adminPutShippingProviders(body.providers);
    }
    if (body.platform) {
      await shippingAdmin.adminPutShippingPlatform(body.platform);
    }
    const data = await shippingAdmin.adminGetShippingConfig();
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async patchService(req, res) {
    const body = await validate(patchServiceSchema, req.body ?? {});
    const row = await shippingAdmin.adminPatchShippingService(req.params.publicId, body);
    if (!row) {
      res.status(404).json({ success: false, message: 'Service not found' });
      return;
    }
    res.status(200).json({ success: true, data: toPublicJson(row) });
  }

  async createService(req, res) {
    const body = await validate(createServiceSchema, req.body ?? {});
    const row = await shippingAdmin.adminCreateShippingService(body);
    res.status(201).json({ success: true, data: toPublicJson(row) });
  }

  async deleteService(req, res) {
    try {
      const ok = await shippingAdmin.adminDeleteShippingService(req.params.publicId);
      if (!ok) {
        res.status(404).json({ success: false, message: 'Service not found' });
        return;
      }
      res.status(200).json({ success: true });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message || String(e) });
    }
  }

  async listLogs(req, res) {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 100);
    const rows = await shippingAdmin.adminListShippingLogs(limit);
    res.status(200).json({ success: true, data: toPublicJson(rows) });
  }

  async testUps(req, res) {
    const body = await validate(testUpsSchema, req.body ?? {});
    const data = await shippingAdmin.adminTestUpsConnection(body || {});
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }
}

export const shippingAdminController = new ShippingAdminController();
