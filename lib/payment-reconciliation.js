/**
 * PAY-01: persist a succeeded charge that has no order so a webhook retry
 * (or an operator) can see it. OPEN rows are resolved once the order exists.
 */

function isMissingTable(error) {
  return Boolean(error && typeof error === 'object' && (error.code === 'P2021' || error.code === 'P2022'));
}

export async function recordOpenPaymentReconciliation(prisma, input) {
  if (!prisma?.paymentReconciliation) {
    console.error('[payments] reconciliation client missing — run prisma generate');
    return null;
  }

  const checkoutIntentPublicId = String(input?.checkoutIntentPublicId || '').trim();
  if (!checkoutIntentPublicId) return null;

  const data = {
    paymentIntentId: input.paymentIntentId ? String(input.paymentIntentId) : null,
    amountCents: Number.isInteger(input.amountCents) ? input.amountCents : null,
    error: String(input.error || 'Paid checkout did not create an order').slice(0, 4000),
    status: 'OPEN',
  };

  try {
    const existing = await prisma.paymentReconciliation.findFirst({
      where: { checkoutIntentPublicId, status: 'OPEN' },
    });
    if (existing) {
      return prisma.paymentReconciliation.update({
        where: { id: existing.id },
        data,
      });
    }
    return prisma.paymentReconciliation.create({
      data: { checkoutIntentPublicId, ...data },
    });
  } catch (error) {
    if (isMissingTable(error)) {
      console.error('[payments] reconciliation table missing — run prisma migrate deploy');
      return null;
    }
    throw error;
  }
}

export async function resolveOpenPaymentReconciliations(prisma, checkoutIntentPublicId) {
  const id = String(checkoutIntentPublicId || '').trim();
  if (!id || !prisma?.paymentReconciliation) return;
  try {
    await prisma.paymentReconciliation.updateMany({
      where: { checkoutIntentPublicId: id, status: 'OPEN' },
      data: { status: 'RESOLVED' },
    });
  } catch (error) {
    if (isMissingTable(error)) return;
    throw error;
  }
}
