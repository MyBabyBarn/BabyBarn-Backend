import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createScanSession,
  joinScanSession,
  relayScanToSession,
  getScanSession,
} from '../services/scan-relay.service.js';

test('scan relay session create, join, and relay', () => {
  const host = { id: 'host-user', email: 'host@test.local' };
  const phone = { id: 'phone-user', email: 'phone@test.local' };

  const created = createScanSession(host);
  assert.match(created.code, /^[A-Z2-9]{6}$/);
  assert.ok(created.expiresAt);
  assert.ok(created.pairingToken);
  assert.match(created.joinPath, /\/warehouse\/scanner\?/);

  const joined = joinScanSession(created.code, created.pairingToken);
  assert.equal(joined.scannerJoined, true);

  const session = getScanSession(created.code);
  assert.equal(session.scannerJoined, true);

  relayScanToSession(created.code, 'BBP-TEST1234', phone, created.pairingToken);
  const after = getScanSession(created.code);
  assert.equal(after.recentScans[0]?.code, 'BBP-TEST1234');
  assert.equal(after.recentScans[0]?.actorEmail, phone.email);
});
