import { inventoryService } from '../services/inventory.service.js';
import { barcodeService } from '../services/barcode.service.js';
import { inventoryScanService } from '../services/inventory-scan.service.js';
import { inventoryScanDraftService } from '../services/inventory-scan-draft.service.js';
import { scanRelayService } from '../services/scan-relay.service.js';
import { validate } from '../utils/validation.js';
import {
  barcodeEnsureSchema,
  barcodeListQuerySchema,
  barcodeLocationSchema,
  barcodeLookupQuerySchema,
  barcodeRegenerateSchema,
  inventoryAdjustSchema,
  inventoryDraftIdentifySchema,
  inventoryDraftLineParamsSchema,
  inventoryDraftLineUpdateSchema,
  inventoryDraftMetaSchema,
  inventoryDraftSessionParamsSchema,
  inventoryProductTypeSchema,
  scanAdjustSchema,
  scanOrderSchema,
  scanOrderRefParamsSchema,
  scanResolveSchema,
  scanRelaySchema,
  scanReturnSchema,
  scanSessionJoinParamsSchema,
  scanPairJoinSchema,
  scanPairApproveSchema,
  scanPairRelaySchema,
  scanVerifySchema,
} from '../schemas/index.js';
import { toPublicJson } from '../utils/serialize.js';
import { AppError } from '../utils/error-handler.js';

export class InventoryController {
  async getStats(req, res) {
    const productType = req.query.productType ? String(req.query.productType) : undefined;
    const stats = await inventoryService.getStats({
      productType:
        productType === 'NEW' || productType === 'REFURBISHED' ? productType : undefined,
    });
    res.status(200).json({ success: true, data: toPublicJson(stats) });
  }

  async list(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 24, 1), 100);
    const search = req.query.search ? String(req.query.search) : undefined;
    const stockStatus = req.query.stockStatus ? String(req.query.stockStatus) : undefined;
    const productType = req.query.productType ? String(req.query.productType) : undefined;

    const result = await inventoryService.list({
      page,
      limit,
      search,
      stockStatus,
      productType,
    });

    res.status(200).json({
      success: true,
      data: toPublicJson(result),
    });
  }

  async adjust(req, res) {
    const body = await validate(inventoryAdjustSchema, req.body);
    const userPublicId = req.user?.id;
    if (!userPublicId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const result = await inventoryService.adjustStock({
      productPublicId: body.productId,
      variantPublicId: body.variantId,
      delta: body.delta,
      reason: body.reason ?? undefined,
      userPublicId,
    });

    res.status(200).json({
      success: true,
      message: 'Inventory updated',
      data: toPublicJson(result),
    });
  }

  async updateProductType(req, res) {
    const { id } = req.params;
    const body = await validate(inventoryProductTypeSchema, req.body);
    const product = await inventoryService.updateProductType(id, body.productType);
    res.status(200).json({
      success: true,
      data: toPublicJson(product),
    });
  }

  async history(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 20, 1), 100);
    const productId = req.query.productId ? String(req.query.productId) : undefined;
    const productType = req.query.productType ? String(req.query.productType) : undefined;
    const search = req.query.search ? String(req.query.search).trim() : undefined;
    const result = await inventoryService.listHistory({
      page,
      limit,
      productPublicId: productId,
      productType:
        productType === 'NEW' || productType === 'REFURBISHED' ? productType : undefined,
      search: search || undefined,
    });
    res.status(200).json({
      success: true,
      data: toPublicJson(result),
    });
  }

  async productTimeline(req, res) {
    const data = await inventoryService.getProductTimeline(req.params.id);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async productOverview(req, res) {
    const data = await inventoryService.getProductOverview(req.params.id);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async listBarcodes(req, res) {
    const { productId } = await validate(barcodeListQuerySchema, req.query);
    const data = await barcodeService.listForProductPublicId(productId);
    res.status(200).json({ success: true, data });
  }

  async lookupBarcode(req, res) {
    const q = await validate(barcodeLookupQuerySchema, req.query);
    const data = await barcodeService.lookup(q.code || q.sku, { ensureIfSku: false });
    res.status(200).json({ success: true, data });
  }

  async ensureBarcodeBySku(req, res) {
    const body = await validate(barcodeEnsureSchema, req.body ?? {});
    const data = await barcodeService.ensureBySku(body.sku);
    res.status(200).json({ success: true, data });
  }

  async updateBarcodeLocation(req, res) {
    const body = await validate(barcodeLocationSchema, req.body ?? {});
    const data = await barcodeService.updateLocation(body.query, body.warehouseLocation, {
      id: req.user?.id ?? null,
      email: req.user?.email ?? null,
    });
    res.status(200).json({ success: true, data });
  }

  async regenerateBarcode(req, res) {
    const body = await validate(barcodeRegenerateSchema, req.body ?? {});
    const data = await barcodeService.regenerate(req.params.code, {
      confirmSent: Boolean(body.confirmSent),
      actor: { id: req.user?.id ?? null, email: req.user?.email ?? null },
    });
    res.status(200).json({ success: true, data });
  }

  async markBarcodeSent(req, res) {
    const data = await barcodeService.markSent(req.params.code, {
      id: req.user?.id ?? null,
      email: req.user?.email ?? null,
    });
    res.status(200).json({ success: true, data });
  }

  async barcodePdf(req, res) {
    const fromQuery = String(req.query.codes || req.query.code || '');
    const fromParam = req.params.code ? String(req.params.code) : '';
    const codes = `${fromQuery},${fromParam}`
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (codes.length === 0 && req.query.sku) {
      const row = await barcodeService.ensureBySku(String(req.query.sku));
      codes.push(row.code);
    }
    const buffer = await barcodeService.renderLabelPdf(codes);
    const filename = codes.length === 1 ? `barcode-${codes[0]}.pdf` : 'barcodes.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.status(200).send(buffer);
  }

  async barcodePng(req, res) {
    let code = String(req.params.code || req.query.code || '').trim();
    if (!code && req.query.sku) {
      const row = await barcodeService.ensureBySku(String(req.query.sku));
      code = row.code;
    }
    const buffer = await barcodeService.renderLabelPng(code);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="barcode-${code}.png"`);
    res.status(200).send(buffer);
  }

  actor(req) {
    return { id: req.user?.id ?? null, email: req.user?.email ?? null };
  }

  async scanResolve(req, res) {
    const body = await validate(scanResolveSchema, req.body ?? {});
    const data = await inventoryScanService.resolveScan(body.code);
    res.status(200).json({ success: true, data });
  }

  async scanReceive(req, res) {
    const body = await validate(scanAdjustSchema, req.body ?? {});
    const data = await inventoryScanService.receiveOrAdd({ ...body, actor: this.actor(req), kind: 'receive' });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async scanAdd(req, res) {
    const body = await validate(scanAdjustSchema, req.body ?? {});
    const data = await inventoryScanService.receiveOrAdd({ ...body, actor: this.actor(req), kind: 'add' });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async scanVerify(req, res) {
    const body = await validate(scanVerifySchema, req.body ?? {});
    const data = await inventoryScanService.verifyCount({ ...body, actor: this.actor(req) });
    res.status(200).json({ success: true, data });
  }

  async scanPick(req, res) {
    const body = await validate(scanOrderSchema, req.body ?? {});
    const data = await inventoryScanService.pickByScan({ ...body, actor: this.actor(req) });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async scanOrderChecklist(req, res) {
    const params = await validate(scanOrderRefParamsSchema, { ref: req.params.ref });
    const data = await inventoryScanService.getOrderPickChecklist(params.ref);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async scanCancelRestore(req, res) {
    const body = await validate(scanOrderSchema, req.body ?? {});
    const data = await inventoryScanService.cancelRestoreByScan({ ...body, actor: this.actor(req) });
    res.status(200).json({ success: true, data });
  }

  async scanReturnRestock(req, res) {
    const body = await validate(scanReturnSchema, req.body ?? {});
    const data = await inventoryScanService.returnRestockByScan({ ...body, actor: this.actor(req) });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async scanRefurb(req, res) {
    const body = await validate(scanReturnSchema, req.body ?? {});
    const data = await inventoryScanService.refurbMoveByScan({ ...body, actor: this.actor(req) });
    res.status(200).json({ success: true, data });
  }

  async createScanSession(req, res) {
    const data = scanRelayService.createScanSession(this.actor(req));
    res.status(201).json({ success: true, data });
  }

  async joinScanSession(req, res) {
    const params = await validate(scanSessionJoinParamsSchema, {
      code: String(req.params.code || '').trim(),
    });
    const body = await validate(scanPairJoinSchema, {
      pairingToken: String(req.body?.pairingToken || ''),
      displayName: req.body?.displayName,
      roleLabel: req.body?.roleLabel,
      deviceLabel: req.body?.deviceLabel,
    });
    const data = scanRelayService.joinScanSession(params.code, body.pairingToken, {
      displayName: body.displayName || req.user?.email || 'Staff scanner',
      roleLabel: body.roleLabel || req.user?.role || 'Team Member',
      deviceLabel: body.deviceLabel || 'Browser',
    });
    res.status(200).json({ success: true, data });
  }

  async approveScanSessionJoin(req, res) {
    const params = await validate(scanSessionJoinParamsSchema, {
      code: String(req.params.code || '').trim(),
    });
    const body = await validate(scanPairApproveSchema, req.body ?? {});
    const data = scanRelayService.approveJoinRequest(params.code, body.pairingToken);
    res.status(200).json({ success: true, data });
  }

  async rejectScanSessionJoin(req, res) {
    const params = await validate(scanSessionJoinParamsSchema, {
      code: String(req.params.code || '').trim(),
    });
    const body = await validate(scanPairApproveSchema, req.body ?? {});
    const data = scanRelayService.rejectJoinRequest(params.code, body.pairingToken);
    res.status(200).json({ success: true, data });
  }

  async disconnectScanSession(req, res) {
    const params = await validate(scanSessionJoinParamsSchema, {
      code: String(req.params.code || '').trim(),
    });
    const body = await validate(scanPairApproveSchema, req.body ?? {});
    const data = scanRelayService.disconnectScanner(params.code, body.pairingToken);
    res.status(200).json({ success: true, data });
  }

  async getScanSession(req, res) {
    const params = await validate(scanSessionJoinParamsSchema, {
      code: String(req.params.code || '').trim(),
    });
    const pairingToken = req.query?.pairingToken ? String(req.query.pairingToken) : undefined;
    const data = scanRelayService.getScanSession(params.code, pairingToken);
    res.status(200).json({ success: true, data });
  }

  /** Login-free phone join (pairing token). */
  async pairJoinScanSession(req, res) {
    const params = await validate(scanSessionJoinParamsSchema, {
      code: String(req.params.code || '').trim(),
    });
    const body = await validate(scanPairJoinSchema, req.body ?? {});
    const ua = String(req.get('user-agent') || '');
    const deviceGuess = /iPhone/i.test(ua)
      ? 'iPhone'
      : /Android/i.test(ua)
        ? 'Android phone'
        : 'Mobile device';
    const data = scanRelayService.joinScanSession(params.code, body.pairingToken, {
      displayName: body.displayName || 'Phone scanner',
      roleLabel: body.roleLabel || 'Team Member',
      deviceLabel: body.deviceLabel || deviceGuess,
    });
    res.status(200).json({ success: true, data });
  }

  /** Login-free phone status (pairing token). */
  async pairGetScanSession(req, res) {
    const params = await validate(scanSessionJoinParamsSchema, {
      code: String(req.params.code || '').trim(),
    });
    const body = await validate(scanPairJoinSchema, {
      pairingToken: String(req.query.pairingToken || ''),
    });
    const data = scanRelayService.getScanSession(params.code, body.pairingToken);
    res.status(200).json({ success: true, data });
  }

  /** Login-free phone relay (pairing token). */
  async pairScanRelay(req, res) {
    const body = await validate(scanPairRelaySchema, req.body ?? {});
    const data = scanRelayService.relayScanToSession(body.sessionCode, body.code, { email: 'phone-scanner' }, body.pairingToken);
    res.status(200).json({ success: true, data });
  }

  async scanSessionEvents(req, res) {
    const params = await validate(scanSessionJoinParamsSchema, {
      code: String(req.params.code || '').trim(),
    });
    const pairingToken = String(req.query?.pairingToken || '').trim();
    if (!pairingToken) {
      throw new AppError(401, 'Pairing token is required', 'PAIRING_TOKEN_REQUIRED');
    }
    scanRelayService.subscribeScanSession(params.code, res, pairingToken);
  }

  async scanSessionQr(req, res) {
    const params = await validate(scanSessionJoinParamsSchema, {
      code: String(req.params.code || '').trim(),
    });
    const pairingToken = String(req.query?.pairingToken || '').trim();
    if (!pairingToken) {
      throw new AppError(401, 'Pairing token is required', 'PAIRING_TOKEN_REQUIRED');
    }
    // Prove the caller knows the session secret before rendering a join QR.
    scanRelayService.assertPairingToken(params.code, pairingToken);
    const joinUrl = req.query.joinUrl ? String(req.query.joinUrl) : undefined;
    const buffer = await scanRelayService.renderSessionJoinQr(params.code, joinUrl);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).send(buffer);
  }

  async scanRelay(req, res) {
    const body = await validate(scanRelaySchema, req.body ?? {});
    const data = scanRelayService.relayScanToSession(
      body.sessionCode,
      body.code,
      this.actor(req),
      body.pairingToken
    );
    res.status(200).json({ success: true, data });
  }

  async getActiveDraftSession(req, res) {
    if (!req.user?.id) throw new AppError(401, 'Unauthorized');
    const data = await inventoryScanDraftService.getOrCreateActiveDraft({
      userPublicId: req.user.id,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async listDraftSessions(req, res) {
    if (!req.user?.id) throw new AppError(401, 'Unauthorized');
    const data = await inventoryScanDraftService.listSessions({
      userPublicId: req.user.id,
      status: req.query.status,
      search: req.query.search,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getDraftSession(req, res) {
    if (!req.user?.id) throw new AppError(401, 'Unauthorized');
    const params = await validate(inventoryDraftSessionParamsSchema, { id: req.params.id });
    // Past-session detail: allow non-draft owned sessions
    const data = await inventoryScanDraftService.getOwnedSession({
      sessionPublicId: params.id,
      userPublicId: req.user.id,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async draftIdentify(req, res) {
    if (!req.user?.id) throw new AppError(401, 'Unauthorized');
    const params = await validate(inventoryDraftSessionParamsSchema, { id: req.params.id });
    const body = await validate(inventoryDraftIdentifySchema, req.body ?? {});
    const data = await inventoryScanDraftService.identifyAndUpsertLine({
      sessionPublicId: params.id,
      userPublicId: req.user.id,
      code: body.code,
      incrementScanned: body.incrementScanned,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async draftUpdateLine(req, res) {
    if (!req.user?.id) throw new AppError(401, 'Unauthorized');
    const params = await validate(inventoryDraftLineParamsSchema, {
      id: req.params.id,
      lineId: req.params.lineId,
    });
    const body = await validate(inventoryDraftLineUpdateSchema, req.body ?? {});
    const data = await inventoryScanDraftService.updateDraftLine({
      sessionPublicId: params.id,
      linePublicId: params.lineId,
      userPublicId: req.user.id,
      ...body,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async draftRemoveLine(req, res) {
    if (!req.user?.id) throw new AppError(401, 'Unauthorized');
    const params = await validate(inventoryDraftLineParamsSchema, {
      id: req.params.id,
      lineId: req.params.lineId,
    });
    const data = await inventoryScanDraftService.removeDraftLine({
      sessionPublicId: params.id,
      linePublicId: params.lineId,
      userPublicId: req.user.id,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async draftUpdateMeta(req, res) {
    if (!req.user?.id) throw new AppError(401, 'Unauthorized');
    const params = await validate(inventoryDraftSessionParamsSchema, { id: req.params.id });
    const body = await validate(inventoryDraftMetaSchema, req.body ?? {});
    const data = await inventoryScanDraftService.updateDraftMeta({
      sessionPublicId: params.id,
      userPublicId: req.user.id,
      ...body,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async draftConfirm(req, res) {
    if (!req.user?.id) throw new AppError(401, 'Unauthorized');
    const params = await validate(inventoryDraftSessionParamsSchema, { id: req.params.id });
    const data = await inventoryScanDraftService.confirmDraft({
      sessionPublicId: params.id,
      userPublicId: req.user.id,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async draftDiscard(req, res) {
    if (!req.user?.id) throw new AppError(401, 'Unauthorized');
    const params = await validate(inventoryDraftSessionParamsSchema, { id: req.params.id });
    const data = await inventoryScanDraftService.discardDraft({
      sessionPublicId: params.id,
      userPublicId: req.user.id,
    });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }
}

export const inventoryController = new InventoryController();
