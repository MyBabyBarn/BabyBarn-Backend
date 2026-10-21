import { listAuditLogs, exportAuditLogs, auditLogsToCsv } from '../services/audit.service.js';
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
  setTeamMemberModules,
  createAdminTeamMember,
  updateTeamMember,
} from '../services/admin.service.js';
import { listStoreCreditActivity as fetchStoreCreditActivity } from '../services/store-credit-admin.service.js';
import { validate } from '../utils/validation.js';
import { z } from 'zod';
import { toPublicJson } from '../utils/serialize.js';

const businessSettingsPatchSchema = z.object({
  accessMembershipPriceUsd: z.number().min(0).max(99999).optional(),
  accessUsedReturnWindowDays: z.number().int().min(30).max(730).optional(),
});

const teamModulesPatchSchema = z.object({
  /** null = full module access for ADMIN_TEAM */
  modules: z.union([z.array(z.string()), z.null()]),
});

const teamMemberCreateSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).optional().nullable(),
  lastName: z.string().min(1).optional().nullable(),
  roleTitle: z.string().min(1).max(80).optional().nullable(),
  modules: z.union([z.array(z.string()), z.null()]).optional().default(null),
  adminNotificationAccess: z.boolean().optional().default(false),
});

const teamMemberUpdateSchema = z.object({
  firstName: z.string().min(1).max(80).optional().nullable(),
  lastName: z.string().min(1).max(80).optional().nullable(),
  roleTitle: z.string().min(1).max(80).optional().nullable(),
  modules: z.union([z.array(z.string()), z.null()]).optional(),
  isActive: z.boolean().optional(),
  adminNotificationAccess: z.boolean().optional(),
});

export class AdminController {
  async getFinanceStats(req, res) {
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : undefined;
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : undefined;
    const data = await getFinanceStats({ dateFrom, dateTo });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getDashboardOverview(req, res) {
    const data = await getDashboardOverview(req.user);
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

  async listAuditLogs(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 50, 100);
    const filters = {
      search: req.query.search ? String(req.query.search) : undefined,
      action: req.query.action ? String(req.query.action) : undefined,
      entityType: req.query.entityType ? String(req.query.entityType) : undefined,
      actorEmail: req.query.actorEmail ? String(req.query.actorEmail) : undefined,
      dateFrom: req.query.dateFrom ? String(req.query.dateFrom) : undefined,
      dateTo: req.query.dateTo ? String(req.query.dateTo) : undefined,
    };
    const data = await listAuditLogs(page, limit, filters);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async exportAuditLogs(req, res) {
    const filters = {
      search: req.query.search ? String(req.query.search) : undefined,
      action: req.query.action ? String(req.query.action) : undefined,
      entityType: req.query.entityType ? String(req.query.entityType) : undefined,
      actorEmail: req.query.actorEmail ? String(req.query.actorEmail) : undefined,
      dateFrom: req.query.dateFrom ? String(req.query.dateFrom) : undefined,
      dateTo: req.query.dateTo ? String(req.query.dateTo) : undefined,
    };
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
    const data = await listCustomers(page, limit, { search, role });
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

  async patchTeamModules(req, res) {
    const body = await validate(teamModulesPatchSchema, req.body);
    const data = await setTeamMemberModules(req.user.id, req.params.id, body.modules);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async createTeamMember(req, res) {
    const body = await validate(teamMemberCreateSchema, req.body);
    const data = await createAdminTeamMember(req.user.id, body);
    res.status(201).json({
      success: true,
      message: 'Team member created. Ask them to log in again after module changes.',
      data: toPublicJson(data),
    });
  }

  async updateTeamMember(req, res) {
    const body = await validate(teamMemberUpdateSchema, req.body);
    const data = await updateTeamMember(req.user.id, req.params.id, body);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }
}

export const adminController = new AdminController();
