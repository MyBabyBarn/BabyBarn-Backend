import { AppError } from '../../../utils/error-handler.js';
import { shippoClient } from '../../providers/shippo.client.js';
import { encodeShippoRateId } from '../rate-id.js';
import {
  toShippoAddress,
  defaultFromAddress,
  hasCompleteAddress,
  sanitizeParcel,
  defaultParcel,
  dummyAddress,
} from '../shipping-address.js';

function mapRate(rate) {
  return {
    rateId: encodeShippoRateId(rate.object_id),
    provider: rate.provider,
    serviceLevel: rate.servicelevel?.name || null,
    serviceToken: rate.servicelevel?.token || null,
    currency: rate.currency,
    amount: Number(rate.amount || 0),
    estimatedDays: rate.estimated_days ?? null,
    attributes: Array.isArray(rate.attributes) ? rate.attributes : [],
    durationTerms: rate.duration_terms || null,
    providerSlug: 'shippo',
    externalRateId: rate.object_id,
  };
}

export async function shippoGetRates(payload) {
  const useDummyAddress = Boolean(payload.useDummyAddress);
  const dummyCountry = String(payload.dummyCountry || 'US').trim();
  const toAddress = useDummyAddress
    ? dummyAddress(dummyCountry)
    : toShippoAddress(payload.shippingAddress || payload.toAddress || {});
  const fromAddress = payload.useDummyFromAddress
    ? dummyAddress('US')
    : toShippoAddress(payload.fromAddress || defaultFromAddress());
  const parcels = Array.isArray(payload.parcels) && payload.parcels.length > 0
    ? payload.parcels.map(sanitizeParcel)
    : [defaultParcel()];

  if (!hasCompleteAddress(toAddress)) {
    return { error: 'incomplete_to', toAddress, fromAddress, parcels };
  }
  if (!hasCompleteAddress(fromAddress) || !shippoClient.hasKey()) {
    return { error: 'not_configured', toAddress, fromAddress, parcels };
  }

  const shipment = await shippoClient.createShipment({
    address_from: fromAddress,
    address_to: toAddress,
    parcels,
    async: false,
  });
  const rates = (shipment.rates || [])
    .map(mapRate)
    .sort((a, b) => Number(a.amount || 0) - Number(b.amount || 0));
  return {
    shipment,
    rates,
    diagnostics: {
      mode: String(process.env.SHIPPO_API_KEY || '').startsWith('shippo_test_') ? 'test' : 'live',
      objectState: shipment.object_state || null,
      messages: shipment.messages || [],
      usedDummyAddress: useDummyAddress,
      addressFrom: fromAddress,
      addressTo: toAddress,
      parcels,
    },
  };
}

export async function shippoCreateShipment(payload) {
  const toAddress = toShippoAddress(payload.shippingAddress || payload.toAddress || {});
  const fromAddress = toShippoAddress(payload.fromAddress || defaultFromAddress());
  const parcels = Array.isArray(payload.parcels) && payload.parcels.length > 0
    ? payload.parcels
    : [defaultParcel()];
  if (!hasCompleteAddress(toAddress)) {
    throw new AppError(400, 'Valid destination address is required', 'SHIPPING_ADDRESS_INVALID');
  }
  if (!hasCompleteAddress(fromAddress)) {
    throw new AppError(500, 'Origin shipping address is not configured', 'SHIP_FROM_NOT_CONFIGURED');
  }
  const shipment = await shippoClient.createShipment({
    address_from: fromAddress,
    address_to: toAddress,
    parcels,
    async: false,
    metadata: payload.metadata || null,
  });
  return {
    provider: 'shippo',
    shipmentId: shipment.object_id,
    rates: (shipment.rates || []).map(mapRate),
    raw: shipment,
  };
}

export async function shippoBuyLabel(payload) {
  const rateId = String(payload.rateId || payload.rate || '').trim();
  if (!rateId) {
    throw new AppError(400, 'rateId is required to buy a label', 'SHIP_LABEL_RATE_REQUIRED');
  }
  const { decodeShippoRateId } = await import('../rate-id.js');
  const rawId = decodeShippoRateId(rateId);
  const tx = await shippoClient.buyLabel({
    rate: rawId,
    label_file_type: payload.labelFileType || 'PDF_4x6',
    async: false,
  });
  const status = String(tx?.status || '').toUpperCase();
  const trackingNumber = tx?.tracking_number || null;
  const shippingLabelUrl = tx?.label_url || null;
  if (status !== 'SUCCESS' || (!trackingNumber && !shippingLabelUrl)) {
    const messages = Array.isArray(tx?.messages) ? tx.messages : [];
    const detail = messages
      .map((m) => m?.text || m?.code || '')
      .filter(Boolean)
      .join('; ');
    const detailLower = detail.toLowerCase();
    const addressInvalid =
      detailLower.includes('address') &&
      (detailLower.includes('invalid') ||
        detailLower.includes('not found') ||
        detailLower.includes('incomplete') ||
        detailLower.includes('recipient'));
    throw new AppError(
      addressInvalid ? 400 : 502,
      detail || `Shippo label purchase failed (${status || 'UNKNOWN'})`,
      addressInvalid ? 'SHIPPING_ADDRESS_INVALID' : 'SHIPPO_LABEL_FAILED',
      { status: tx?.status || null, messages, transactionId: tx?.object_id || null }
    );
  }
  return {
    provider: 'shippo',
    transactionId: tx.object_id,
    status: tx.status,
    trackingNumber,
    shippingCarrier: tx.tracking_status?.carrier || tx.rate?.provider || 'USPS',
    shippingLabelUrl,
    qrCodeUrl: tx.qr_code_url || null,
    messages: tx.messages || [],
    raw: tx,
  };
}

export async function shippoTrack(carrier, trackingNumber) {
  const data = await shippoClient.track(carrier, trackingNumber);
  return {
    carrier,
    trackingNumber,
    status: data?.tracking_status?.status || 'UNKNOWN',
    statusDetails: data?.tracking_status?.status_details || null,
    statusDate: data?.tracking_status?.status_date || null,
    eta: data?.eta || null,
    history: Array.isArray(data?.tracking_history) ? data.tracking_history : [],
    addressFrom: data?.address_from || null,
    addressTo: data?.address_to || null,
    raw: data,
  };
}
