import { adminNotificationService } from '../services/admin-notification.service.js';

export class AdminNotificationController {
  async list(req, res) {
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = Math.min(Math.max(req.query.limit ? Number(req.query.limit) : 20, 1), 100);
    const unreadOnly = String(req.query.unreadOnly || '') === 'true';
    const data = await adminNotificationService.listForUser(req.user, { page, limit, unreadOnly });
    res.status(200).json({ success: true, data });
  }

  async unreadCount(req, res) {
    const unreadCount = await adminNotificationService.unreadCountForUser(req.user);
    res.status(200).json({ success: true, data: { unreadCount } });
  }

  async recent(req, res) {
    const limit = Math.min(Math.max(req.query.limit ? Number(req.query.limit) : 8, 1), 50);
    const items = await adminNotificationService.getRecentForUser(req.user, limit);
    const unreadCount = await adminNotificationService.unreadCountForUser(req.user);
    res.status(200).json({ success: true, data: { items, unreadCount } });
  }

  async markRead(req, res) {
    const publicId = String(req.params.publicId || '');
    await adminNotificationService.markRead(req.user, publicId);
    res.status(200).json({ success: true });
  }

  async markAllRead(req, res) {
    const data = await adminNotificationService.markAllRead(req.user);
    res.status(200).json({ success: true, data });
  }
}

export const adminNotificationController = new AdminNotificationController();
