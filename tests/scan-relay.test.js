import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createScanSession,
  joinScanSession,
  approveJoinRequest,
  rejectJoinRequest,
  relayScanToSession,
  getScanSession,
} from '../services/scan-relay.service.js';

test('scan relay requires host approval before scans', () => {
  const host = { id: 'host-user', email: 'host@test.local' };
  const phone = { id: 'phone-user', email: 'phone@test.local' };

  const created = createScanSession(host);
  assert.match(created.code, /^[A-Z2-9]{6}$/);
  assert.ok(created.pairingToken);

  const requested = joinScanSession(created.code, created.pairingToken, {
    displayName: 'John Doe',
    roleLabel: 'Team Member',
    deviceLabel: 'iPhone 14',
  });
  assert.equal(requested.pendingApproval, true);
  assert.equal(requested.scannerJoined, false);

  const pending = getScanSession(created.code, created.pairingToken);
  assert.equal(pending.scannerJoined, false);
  assert.equal(pending.pendingJoin?.displayName, 'John Doe');

  assert.throws(
    () => relayScanToSession(created.code, 'BBP-TEST1234', phone, created.pairingToken),
    (err) => err?.code === 'SCANNER_NOT_APPROVED' || err?.statusCode === 403
  );

  const approved = approveJoinRequest(created.code, created.pairingToken);
  assert.equal(approved.scannerJoined, true);

  relayScanToSession(created.code, 'BBP-TEST1234', phone, created.pairingToken);
  const after = getScanSession(created.code, created.pairingToken);
  assert.equal(after.recentScans[0]?.code, 'BBP-TEST1234');
});

test('scan relay reject clears pending join', () => {
  const created = createScanSession({ id: 'h2' });
  joinScanSession(created.code, created.pairingToken, { displayName: 'Reject Me' });
  rejectJoinRequest(created.code, created.pairingToken);
  const session = getScanSession(created.code, created.pairingToken);
  assert.equal(session.pendingJoin, null);
  assert.equal(session.scannerJoined, false);
});
