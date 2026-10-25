/**
 * SCL-03: prefer indexed prefix matches; avoid scanning long description text
 * for every short query.
 * @param {string} rawQuery
 * @param {{ includeDescription?: boolean }} [options]
 */
export function buildProductSearchOr(rawQuery, options = {}) {
  const includeDescription = options.includeDescription !== false;
  const q = String(rawQuery || '').trim();
  if (!q) return null;
  if (q.length < 2) {
    return [{ sku: { equals: q, mode: 'insensitive' } }];
  }
  const or = [
    { name: { startsWith: q, mode: 'insensitive' } },
    { name: { contains: q, mode: 'insensitive' } },
    { sku: { startsWith: q, mode: 'insensitive' } },
    { sku: { contains: q, mode: 'insensitive' } },
  ];
  // Description scan only for longer queries (expensive ILIKE).
  if (includeDescription && q.length >= 4) {
    or.push({ description: { contains: q, mode: 'insensitive' } });
  }
  return or;
}
