/**
 * Derive a business module slug from AdminAuditLog entityType + action.
 * Used for UI columns and server-side module filters (no module column on the table).
 */

export const AUDIT_MODULE_LABELS = {
  'order-management': 'Order Management',
  'returns-refurbishment': 'Returns & Refurbishment',
  'inventory-management': 'Inventory Management',
  'product-management': 'Product Management',
  'finance-management': 'Finance Management',
  'membership-management': 'Membership Management',
  'user-management': 'User Management',
  'content-management': 'Content Management',
  team: 'Team',
  system: 'System',
};

const ENTITY_TO_MODULE = {
  Order: 'order-management',
  OrderItem: 'order-management',
  PickupList: 'order-management',
  ReturnRequest: 'returns-refurbishment',
  ReturnReceivePackage: 'returns-refurbishment',
  RefurbishmentJob: 'returns-refurbishment',
  RefurbInspectionRecord: 'returns-refurbishment',
  Product: 'product-management',
  ProductVariant: 'product-management',
  Category: 'product-management',
  InventoryAdjustment: 'inventory-management',
  InventoryScanSession: 'inventory-management',
  Barcode: 'inventory-management',
  User: 'user-management',
  MembershipPayment: 'membership-management',
  MembershipShareCode: 'membership-management',
  StoreCreditWallet: 'finance-management',
  StoreCreditLedger: 'finance-management',
  Payment: 'finance-management',
  BlogPost: 'content-management',
  BlogCategory: 'content-management',
  HomepageCarouselSlide: 'content-management',
  ProductReview: 'content-management',
  PlatformReview: 'content-management',
};

const MODULE_ACTION_PREFIXES = {
  'order-management': ['ORDER_', 'PICKUP_', 'FULFILLMENT_', 'CANCELLATION_'],
  'returns-refurbishment': ['RETURN_', 'REFURB_'],
  'inventory-management': ['INVENTORY_', 'BARCODE_', 'SCAN_'],
  'product-management': ['PRODUCT_', 'CATEGORY_'],
  team: ['TEAM_', 'STAFF_'],
  'membership-management': ['MEMBERSHIP_', 'ACCESS_', 'SHARE_'],
  'finance-management': ['FINANCE_', 'REFUND_', 'STORE_CREDIT_'],
  'content-management': ['BLOG_', 'HOMEPAGE_', 'REVIEW_'],
  'user-management': ['CUSTOMER_', 'USER_'],
};

export function deriveAuditModule(entityType, action) {
  const entity = String(entityType || '');
  if (ENTITY_TO_MODULE[entity]) {
    // TEAM_/STAFF_ on User still count as team
    const act = String(action || '');
    if (/^(TEAM_|STAFF_)/i.test(act)) return 'team';
    return ENTITY_TO_MODULE[entity];
  }
  const act = String(action || '');
  for (const [mod, prefixes] of Object.entries(MODULE_ACTION_PREFIXES)) {
    if (prefixes.some((p) => act.toUpperCase().startsWith(p))) return mod;
  }
  return 'system';
}

export function auditActionOk(action) {
  return !/FAILED|ERROR|DENIED/i.test(String(action || ''));
}

/** Prisma where fragment that matches logs belonging to a module slug. */
export function moduleFilterWhere(moduleSlug) {
  const mod = String(moduleSlug || '');
  if (!mod || mod === 'all') return null;

  if (mod === 'system') {
    const known = Object.keys(ENTITY_TO_MODULE);
    const prefixOr = Object.values(MODULE_ACTION_PREFIXES)
      .flat()
      .map((p) => ({ action: { startsWith: p, mode: 'insensitive' } }));
    return {
      AND: [{ entityType: { notIn: known } }, { NOT: { OR: prefixOr } }],
    };
  }

  const entityTypes = Object.entries(ENTITY_TO_MODULE)
    .filter(([, m]) => m === mod)
    .map(([et]) => et);
  const prefixes = MODULE_ACTION_PREFIXES[mod] || [];
  const or = [];
  if (entityTypes.length) {
    // Keep TEAM_/STAFF_ User rows under `team`, not user-management.
    if (mod === 'user-management') {
      or.push({
        AND: [
          { entityType: { in: entityTypes } },
          { NOT: { action: { startsWith: 'TEAM_', mode: 'insensitive' } } },
          { NOT: { action: { startsWith: 'STAFF_', mode: 'insensitive' } } },
        ],
      });
    } else {
      or.push({ entityType: { in: entityTypes } });
    }
  }
  for (const p of prefixes) {
    or.push({ action: { startsWith: p, mode: 'insensitive' } });
  }
  return or.length ? { OR: or } : null;
}

export function formatAuditDetails(action, entityType, entityId, meta) {
  const label = humanizeAuditAction(action, meta);
  const record = entityId ? `${entityType || 'Record'} ${entityId}` : entityType || '';
  const noteParts = [];
  if (meta?.trackingNumber) noteParts.push(`Tracking ${meta.trackingNumber}`);
  if (meta?.note) noteParts.push(String(meta.note));
  const from = meta?.from != null ? String(meta.from) : null;
  const to = meta?.to != null ? String(meta.to) : null;
  if (from && to && !label.includes('→')) noteParts.push(`${from} → ${to}`);
  const note = noteParts.length ? ` — ${noteParts.join(' · ')}` : '';
  return `${label}${record ? ` · ${record}` : ''}${note}`;
}

export function humanizeAuditAction(action, meta) {
  const from = meta && meta.from != null ? String(meta.from) : null;
  const to = meta && meta.to != null ? String(meta.to) : null;
  const a = String(action || '');
  const map = {
    ORDER_STATUS: from && to ? `Status changed ${from} → ${to}` : 'Order status updated',
    ORDER_REFUND: 'Order refunded',
    ORDER_LABEL_PURCHASED: 'Shipping label purchased',
    ORDER_RETURN_LABEL_PURCHASED: 'Return label purchased',
    ORDER_SHIPPING_UPDATED: 'Shipping details updated',
    ORDER_TRACKING_ADDED: 'Tracking added',
    ORDER_ITEM_PICKED:
      meta?.pickedQuantity != null ? `Item picked (${meta.pickedQuantity} units)` : 'Item picked',
    CANCELLATION_APPROVED: 'Cancellation approved',
    CANCELLATION_REJECTED: 'Cancellation rejected',
    PICKUP_LIST_CREATED: 'Pickup list created',
    RETURN_STATUS: from && to ? `Return status ${from} → ${to}` : 'Return status updated',
    RETURN_NOTES: 'Return notes updated',
    REFURB_JOB_STATUS: from && to ? `Refurbishment ${from} → ${to}` : 'Refurbishment job updated',
    TEAM_MEMBER_CREATED: 'Team member created',
    TEAM_MEMBER_UPDATED: 'Team member updated',
    TEAM_MEMBER_DELETED: 'Team member deleted',
    TEAM_MEMBER_DISABLED: 'Team member disabled',
    TEAM_MODULES_UPDATED: 'Team modules updated',
    TEAM_INVITE_RESENT: 'Invite resent',
    TEAM_PASSWORD_RESET: 'Password reset',
    TEAM_INVITE_EMAIL_FAILED: 'Invite email failed',
    STAFF_SIGN_IN: 'Signed in',
  };
  if (map[a]) return map[a];
  if (a.startsWith('FULFILLMENT_')) {
    const step = a.replace('FULFILLMENT_', '').replace(/_/g, ' ');
    return from && to ? `Fulfillment: ${from} → ${to}` : `Fulfillment: ${step}`;
  }
  return a.replace(/_/g, ' ');
}

export function entityRecordHref(entityType, entityId) {
  const id = encodeURIComponent(String(entityId || ''));
  switch (entityType) {
    case 'Order':
      return `/admin/orders/${id}`;
    case 'PickupList':
      return `/admin/pickup`;
    case 'ReturnRequest':
      return `/admin/returns`;
    case 'RefurbishmentJob':
    case 'RefurbInspectionRecord':
      return `/admin/inspection`;
    case 'Product':
      return `/admin/products/${id}`;
    case 'Category':
      return `/admin/categories`;
    case 'User':
      return `/admin/customers/${id}`;
    case 'BlogPost':
      return `/admin/blog/${id}`;
    case 'HomepageCarouselSlide':
      return `/admin/homepage-carousel/${id}`;
    default:
      return null;
  }
}
