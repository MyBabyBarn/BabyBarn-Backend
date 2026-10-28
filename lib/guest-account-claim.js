/**
 * SEC-01: registering with a guest-checkout email must not expose that
 * account's orders until the address is verified. The password can be stored,
 * but no session is issued and guest orders stay unlinked.
 */
export function guestConversionPolicy() {
  return Object.freeze({
    emailVerifiedAt: null,
    issueSessionTokens: false,
    linkOrdersBeforeVerification: false,
    requiresEmailVerification: true,
  });
}

export function guestConversionUpdate({
  hashedPassword,
  firstName,
  lastName,
  existingFirstName,
  existingLastName,
}) {
  const policy = guestConversionPolicy();
  return {
    password: hashedPassword,
    firstName: firstName?.trim() || existingFirstName,
    lastName: lastName?.trim() || existingLastName,
    isGuest: false,
    convertedAt: new Date(),
    emailVerifiedAt: policy.emailVerifiedAt,
    accessOnboardingPending: true,
  };
}
