import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guestConversionPolicy, guestConversionUpdate } from '../lib/guest-account-claim.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('SEC-01: guest conversion does not verify email, issue a session, or link orders', () => {
  const policy = guestConversionPolicy();
  assert.equal(policy.emailVerifiedAt, null);
  assert.equal(policy.issueSessionTokens, false);
  assert.equal(policy.linkOrdersBeforeVerification, false);
  assert.equal(policy.requiresEmailVerification, true);

  const update = guestConversionUpdate({
    hashedPassword: 'hashed',
    firstName: 'A',
    lastName: 'B',
    existingFirstName: 'Guest',
    existingLastName: 'Buyer',
  });
  assert.equal(update.emailVerifiedAt, null);
  assert.equal(update.isGuest, false);
  assert.equal(update.password, 'hashed');
  assert.equal(Object.hasOwn(update, 'token'), false);
});

test('SEC-01: register waits for verification; verify-email is what links guest orders', () => {
  const source = readFileSync(join(__dirname, '../services/auth.service.js'), 'utf8');
  const guestStart = source.indexOf('if (existingUser.isGuest)');
  const guestEnd = source.indexOf("throw new AppError(", guestStart);
  const guestBlock = source.slice(guestStart, guestEnd);

  assert.match(guestBlock, /guestConversionPolicy/);
  assert.match(guestBlock, /if \(policy\.linkOrdersBeforeVerification\)/);
  assert.match(guestBlock, /policy\.issueSessionTokens/);
  assert.match(guestBlock, /requiresEmailVerification: policy\.requiresEmailVerification/);
  assert.doesNotMatch(guestBlock, /emailVerifiedAt: existingUser\.emailVerifiedAt/);

  const verifyStart = source.indexOf('async verifyEmail');
  const verifyBlock = source.slice(verifyStart, verifyStart + 4000);
  assert.match(verifyBlock, /linkEligibleGuestOrdersToUser/);
});
