/**
 * Variant axis ordering + cartesian product (mirrors admin-fe variant-matrix.ts).
 */

function axisPriority(name) {
  const n = String(name).trim().toLowerCase();
  if (n === 'age') return 0;
  if (n === 'color' || n === 'colour') return 1;
  return 2;
}

export function orderVariantAxes(axes) {
  return axes
    .map((a, index) => ({ ...a, index }))
    .filter((a) => String(a.name ?? '').trim() && Array.isArray(a.values) && a.values.length > 0)
    .sort((a, b) => {
      const pa = axisPriority(a.name);
      const pb = axisPriority(b.name);
      if (pa !== pb) return pa - pb;
      return a.index - b.index;
    })
    .map(({ name, values }) => ({
      name: String(name).trim(),
      values: [...new Set(values.map((v) => String(v).trim()).filter(Boolean))],
    }));
}

export function cartesianProduct(arrays) {
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  if (first.length === 0) return [];
  const tail = cartesianProduct(rest);
  return first.flatMap((f) => tail.map((t) => [f, ...t]));
}

export function comboKeyFromValues(values) {
  return JSON.stringify(values);
}

export function comboKeyFromCombination(axisNames, combination) {
  const values = axisNames.map((n) => String(combination?.[n] ?? ''));
  return comboKeyFromValues(values);
}

export function buildSkuBase(productName) {
  return (
    String(productName || 'ITEM')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '')
      .slice(0, 10) || 'ITEM'
  );
}

export function skuSuffixFromCombo(comboValues) {
  const ageBit = comboValues.join('-').replace(/[^A-Za-z0-9]+/g, '').slice(0, 16) || 'OS';
  return ageBit;
}
