import { Router } from 'express';
import { inventoryController } from '../controllers/inventory.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { requireConsoleModule, requireConsoleModuleAny } from '../middleware/admin-console.js';

const router = Router();

router.get(
  '/stats',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('inventory'),
  (req, res, next) => inventoryController.getStats(req, res).catch(next)
);

router.get(
  '/',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('inventory'),
  (req, res, next) => inventoryController.list(req, res).catch(next)
);

router.get(
  '/history',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('inventory'),
  (req, res, next) => inventoryController.history(req, res).catch(next)
);

router.post(
  '/adjust',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('inventory'),
  (req, res, next) => inventoryController.adjust(req, res).catch(next)
);

router.get(
  '/products/:id/overview',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModuleAny(['inventory', 'returns']),
  (req, res, next) => inventoryController.productOverview(req, res).catch(next)
);

router.get(
  '/products/:id/timeline',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('inventory'),
  (req, res, next) => inventoryController.productTimeline(req, res).catch(next)
);

router.patch(
  '/products/:id/type',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('inventory'),
  (req, res, next) => inventoryController.updateProductType(req, res).catch(next)
);

const barcodeStaff = [authenticate, authorize('ADMIN', 'ADMIN_TEAM'), requireConsoleModuleAny(['inventory', 'products'])];

router.get('/barcodes/lookup', ...barcodeStaff, (req, res, next) =>
  inventoryController.lookupBarcode(req, res).catch(next)
);
router.get('/barcodes/pdf', ...barcodeStaff, (req, res, next) =>
  inventoryController.barcodePdf(req, res).catch(next)
);
router.get('/barcodes/png', ...barcodeStaff, (req, res, next) =>
  inventoryController.barcodePng(req, res).catch(next)
);
router.post('/barcodes/ensure', ...barcodeStaff, (req, res, next) =>
  inventoryController.ensureBarcodeBySku(req, res).catch(next)
);
router.patch('/barcodes/location', ...barcodeStaff, (req, res, next) =>
  inventoryController.updateBarcodeLocation(req, res).catch(next)
);
router.get('/barcodes/:code/pdf', ...barcodeStaff, (req, res, next) =>
  inventoryController.barcodePdf(req, res).catch(next)
);
router.get('/barcodes/:code/png', ...barcodeStaff, (req, res, next) =>
  inventoryController.barcodePng(req, res).catch(next)
);
router.post('/barcodes/:code/sent', ...barcodeStaff, (req, res, next) =>
  inventoryController.markBarcodeSent(req, res).catch(next)
);
router.post('/barcodes/:code/regenerate', ...barcodeStaff, (req, res, next) =>
  inventoryController.regenerateBarcode(req, res).catch(next)
);
router.get('/barcodes', ...barcodeStaff, (req, res, next) =>
  inventoryController.listBarcodes(req, res).catch(next)
);

router.post('/scan/resolve', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanResolve(req, res).catch(next)
);
router.get('/scan/draft-sessions/active', ...barcodeStaff, (req, res, next) =>
  inventoryController.getActiveDraftSession(req, res).catch(next)
);
router.get('/scan/draft-sessions', ...barcodeStaff, (req, res, next) =>
  inventoryController.listDraftSessions(req, res).catch(next)
);
router.get('/scan/draft-sessions/:id', ...barcodeStaff, (req, res, next) =>
  inventoryController.getDraftSession(req, res).catch(next)
);
router.post('/scan/draft-sessions/:id/identify', ...barcodeStaff, (req, res, next) =>
  inventoryController.draftIdentify(req, res).catch(next)
);
router.patch('/scan/draft-sessions/:id/lines/:lineId', ...barcodeStaff, (req, res, next) =>
  inventoryController.draftUpdateLine(req, res).catch(next)
);
router.delete('/scan/draft-sessions/:id/lines/:lineId', ...barcodeStaff, (req, res, next) =>
  inventoryController.draftRemoveLine(req, res).catch(next)
);
router.patch('/scan/draft-sessions/:id', ...barcodeStaff, (req, res, next) =>
  inventoryController.draftUpdateMeta(req, res).catch(next)
);
router.post('/scan/draft-sessions/:id/confirm', ...barcodeStaff, (req, res, next) =>
  inventoryController.draftConfirm(req, res).catch(next)
);
router.post('/scan/draft-sessions/:id/discard', ...barcodeStaff, (req, res, next) =>
  inventoryController.draftDiscard(req, res).catch(next)
);
router.post('/scan/receive', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanReceive(req, res).catch(next)
);
router.post('/scan/add', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanAdd(req, res).catch(next)
);
router.post('/scan/verify', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanVerify(req, res).catch(next)
);
router.post('/scan/pick', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanPick(req, res).catch(next)
);
router.get('/scan/orders/:ref', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanOrderChecklist(req, res).catch(next)
);
router.post('/scan/cancel-restore', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanCancelRestore(req, res).catch(next)
);
router.post('/scan/return-restock', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanReturnRestock(req, res).catch(next)
);
router.post('/scan/refurb', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanRefurb(req, res).catch(next)
);

router.post('/scan/sessions', ...barcodeStaff, (req, res, next) =>
  inventoryController.createScanSession(req, res).catch(next)
);
router.post('/scan/sessions/:code/join', ...barcodeStaff, (req, res, next) =>
  inventoryController.joinScanSession(req, res).catch(next)
);
router.post('/scan/sessions/:code/approve', ...barcodeStaff, (req, res, next) =>
  inventoryController.approveScanSessionJoin(req, res).catch(next)
);
router.post('/scan/sessions/:code/reject', ...barcodeStaff, (req, res, next) =>
  inventoryController.rejectScanSessionJoin(req, res).catch(next)
);
router.post('/scan/sessions/:code/disconnect', ...barcodeStaff, (req, res, next) =>
  inventoryController.disconnectScanSession(req, res).catch(next)
);
router.get('/scan/sessions/:code', ...barcodeStaff, (req, res, next) =>
  inventoryController.getScanSession(req, res).catch(next)
);
/** QR requires staff auth + pairingToken (never public by session code alone). */
router.get('/scan/sessions/:code/qr', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanSessionQr(req, res).catch(next)
);
/** SSE auth via short-lived pairingToken query — not the long-lived access JWT. */
router.get('/scan/sessions/:code/events', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanSessionEvents(req, res).catch(next)
);
router.post('/scan/relay', ...barcodeStaff, (req, res, next) =>
  inventoryController.scanRelay(req, res).catch(next)
);

/** Login-free phone scanner pairing (short-lived token from host session create). */
router.post('/scan/pair/:code/join', (req, res, next) =>
  inventoryController.pairJoinScanSession(req, res).catch(next)
);
router.get('/scan/pair/:code', (req, res, next) =>
  inventoryController.pairGetScanSession(req, res).catch(next)
);
router.post('/scan/pair/relay', (req, res, next) =>
  inventoryController.pairScanRelay(req, res).catch(next)
);

export default router;
