import {
  listAuditLogs,
  exportAuditLogs,
  auditLogsToCsv,
  listAuditLogFacets,
  getAuditLogById,
} from '../services/audit.service.js';
import {
  getFinanceStats,
  getDashboardOverview,
  listFinanceTransactions,
  listCustomers,
  getCustomerDetail,
  setUserActive,
  listAccessMembers,
  getBusinessSettings,
  updateBusinessSettings,
  listAdminTeamMembers,
  getAdminTeamMember,
  setTeamMemberModules,
  createAdminTeamMember,
  updateTeamMember,
  resendTeamInvite,
  resetTeamMemberPassword,
  listTeamMemberActivity,
  deleteTeamMember,
} from '../services/admin.service.js';
import {
  fetchStoreCreditActivity,
  fetchStoreCreditOverview,
} from '../services/store-credit-admin.service.js';
import { validate } from '../utils/validation.js';
import { z } from 'zod';
import { toPublicJson } from '../utils/serialize.js';

const businessSettingsPatchSchema = z.object({
  accessMembershipPriceUsd: z.number().min(0).max(99999).optional(),
  accessUsedReturnWindowDays: z.number().int().min(30).max(730).optional(),
});

const teamAccessSchema = z.union([
  z.array(z.string()),
  z.record(z.string(), z.array(z.string())),
  z.null(),
]);

const teamModulesPatchSchema = z.object({
  /** Legacy string[] or action map Record<module, actionId[]> */
  modules: teamAccessSchema,
  access: z.record(z.string(), z.array(z.string())).optional(),
});

const teamAddressSchema = z
  .object({
    line1: z.string().max(120).optional().nullable(),
    line2: z.string().max(120).optional().nullable(),
    city: z.string().max(80).optional().nullable(),
    state: z.string().max(40).optional().nullable(),
    zip: z.string().max(20).optional().nullable(),
    country: z.string().max(40).optional().nullable(),
    phoneNumber: z.string().max(30).optional().nullable(),
  })
  .optional()
  .nullable();

const teamMemberCreateSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).optional().nullable(),
  lastName: z.string().min(1).optional().nullable(),
  roleTitle: z.string().min(1).max(80).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  modules: teamAccessSchema.optional().default(null),
  access: z.record(z.string(), z.array(z.string())).optional(),
  inviteMethod: z.enum(['temp', 'invite']).optional().default('temp'),
  emailCreds: z.boolean().optional().default(true),
  adminNotificationAccess: z.boolean().optional().default(false),
  adminModuleOptions: z
    .object({ orders: z.enum(['all', 'assigned']).optional() })
    .optional()
    .nullable(),
});

const teamMemberUpdateSchema = z.object({
  firstName: z.string().min(1).max(80).optional().nullable(),
  lastName: z.string().min(1).max(80).optional().nullable(),
  roleTitle: z.string().min(1).max(80).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  modules: teamAccessSchema.optional(),
  access: z.record(z.string(), z.array(z.string())).optional(),
  isActive: z.boolean().optional(),
  adminNotificationAccess: z.boolean().optional(),
  adminModuleOptions: z
    .object({ orders: z.enum(['all', 'assigned']).optional() })
    .optional()
    .nullable(),
  address: teamAddressSchema,
});

export class AdminController {
  async getFinanceStats(req, res) {
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : undefined;
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : undefined;
    const data = await getFinanceStats({ dateFrom, dateTo });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getDashboardOverview(req, res) {
    const rangeRaw = req.query.range != null ? String(req.query.range) : '7';
    const range = ['1', '7', '30'].includes(rangeRaw) ? rangeRaw : '7';
    const data = await getDashboardOverview(req.user, { range });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async listFinanceTransactions(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 20, 100);
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : undefined;
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : undefined;
    const orderId = req.query.orderId ? String(req.query.orderId) : undefined;
    const membershipRef = req.query.membershipRef ? String(req.query.membershipRef) : undefined;
    const transactionType = req.query.transactionType ? String(req.query.transactionType) : undefined;
    const data = await listFinanceTransactions(page, limit, {
      dateFrom,
      dateTo,
      orderId,
      membershipRef,
      transactionType,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async listStoreCreditActivity(req, res) {
    void req;
    const data = await fetchStoreCreditActivity();
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getStoreCreditOverview(req, res) {
    const data = await fetchStoreCreditOverview({
      tab: req.query.tab,
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search || req.query.q,
      quick: req.query.quick || req.query.qk,
      type: req.query.type,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  parseAuditFilters(query) {
    return {
      search: query.search ? String(query.search) : undefined,
      action: query.action ? String(query.action) : undefined,
      entityType: query.entityType ? String(query.entityType) : undefined,
      entityId: query.entityId ? String(query.entityId) : undefined,
      actorEmail: query.actorEmail ? String(query.actorEmail) : undefined,
      actorId: query.actorId ? String(query.actorId) : undefined,
      module: query.module ? String(query.module) : undefined,
      result: query.result ? String(query.result) : undefined,
      dateFrom: query.dateFrom ? String(query.dateFrom) : undefined,
      dateTo: query.dateTo ? String(query.dateTo) : undefined,
      excludeId: query.excludeId ? String(query.excludeId) : undefined,
    };
  }

  async listAuditLogs(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 50, 100);
    const filters = this.parseAuditFilters(req.query);
    const data = await listAuditLogs(page, limit, filters);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getAuditLog(req, res) {
    const data = await getAuditLogById(req.params.id);
    if (!data) {
      res.status(404).json({ success: false, message: 'Activity log not found' });
      return;
    }
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async listAuditLogFacets(req, res) {
    void req;
    const data = await listAuditLogFacets();
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async exportAuditLogs(req, res) {
    const filters = this.parseAuditFilters(req.query);
    const rows = await exportAuditLogs(filters);
    const csv = auditLogsToCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.status(200).send(`\uFEFF${csv}`);
  }

  async listCustomers(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 20, 100);
    const search = req.query.search ? String(req.query.search) : undefined;
    const role = req.query.role ? String(req.query.role) : undefined;
    const tab = req.query.tab ? String(req.query.tab) : 'all';
    const membership = req.query.membership ? String(req.query.membership) : undefined;
    const has = req.query.has ? String(req.query.has) : undefined;
    const sort = req.query.sort ? String(req.query.sort) : 'new';
    const data = await listCustomers(page, limit, {
      search,
      role,
      tab,
      membership,
      has,
      sort,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getCustomer(req, res) {
    const data = await getCustomerDetail(req.params.id);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async patchCustomerActive(req, res) {
    const body = await validate(
      z.object({ isActive: z.boolean() }),
      req.body
    );
    const data = await setUserActive(req.params.id, body.isActive);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async listAccessMembers(req, res) {
    const filter = req.query.filter ? String(req.query.filter) : 'all';
    const data = await listAccessMembers({ filter });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getBusinessSettings(req, res) {
    const data = await getBusinessSettings();
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async patchBusinessSettings(req, res) {
    const body = await validate(businessSettingsPatchSchema, req.body);
    const data = await updateBusinessSettings(body);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async listTeam(req, res) {
    const data = await listAdminTeamMembers(req.user.id);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getTeamMember(req, res) {
    const data = await getAdminTeamMember(req.user.id, req.params.id);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async listTeamMemberActivity(req, res) {
    const limit = parseInt(String(req.query.limit), 10) || 6;
    const data = await listTeamMemberActivity(req.user.id, req.params.id, { limit });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async patchTeamModules(req, res) {
    const body = await validate(teamModulesPatchSchema, req.body);
    const data = await setTeamMemberModules(
      req.user.id,
      req.params.id,
      body.access ?? body.modules
    );
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async createTeamMember(req, res) {
    const body = await validate(teamMemberCreateSchema, req.body);
    const data = await createAdminTeamMember(req.user.id, body);
    const message =
      body.inviteMethod === 'invite'
        ? 'Invite sent to the email you entered. They set their own password from that message.'
        : body.emailCreds !== false
          ? 'Team member created. A set-password link was emailed; copy the one-time password if shown.'
          : 'Team member created. Share the one-time password securely; they must change it at first sign-in.';
    res.status(201).json({
      success: true,
      message,
      data: toPublicJson(data),
    });
  }

  async updateTeamMember(req, res) {
    const body = await validate(teamMemberUpdateSchema, req.body);
    const data = await updateTeamMember(req.user.id, req.params.id, body);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async resendTeamInvite(req, res) {
    const data = await resendTeamInvite(req.user.id, req.params.id);
    res.status(200).json({
      success: true,
      message: 'Invite resent to the email on this account.',
      data: toPublicJson(data),
    });
  }

  async resetTeamMemberPassword(req, res) {
    const data = await resetTeamMemberPassword(req.user.id, req.params.id);
    res.status(200).json({
      success: true,
      message: 'Password reset email sent. Open sessions were signed out.',
      data: toPublicJson(data),
    });
  }

  async deleteTeamMember(req, res) {
    const data = await deleteTeamMember(req.user.id, req.params.id);
    res.status(200).json({ success: true, message: data.message, data: toPublicJson(data) });
  }
}

export const adminController = new AdminController();
