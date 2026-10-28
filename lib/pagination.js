/**
 * SCL-04: hard-cap list page sizes so callers cannot request unbounded result sets.
 */
export function clampLimit(raw, { fallback = 20, max = 100, min = 1 } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export function clampPage(raw, { fallback = 1 } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.trunc(n);
}
