/** Floor's model column holds shopper-facing type/variant, never a catalog MPN. */
const text = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const meaningful = value => {
  const s = text(value);
  return /^(all|default|standard|unspecified|not applicable|n\/?a|none)$/i.test(s) ? '' : s;
};
const aspect = (aspects, names) => {
  for (const name of names) {
    const entry = Object.entries(aspects || {}).find(([key]) => key.toLowerCase().replace(/[_-]/g, ' ') === name);
    const value = meaningful(entry?.[1]);
    if (value) return value;
  }
  return '';
};
function countIn(value) {
  const s = text(value);
  const pack = s.match(/\b(?:pack|case|set)\s*(?:of\s*)?(\d+)\b|\b(\d+)\s*[- ]?\s*(?:pack|pk)\b/i);
  if (pack && Number(pack[1] || pack[2]) > 1) return `${Number(pack[1] || pack[2])} pack`;
  const count = s.match(/\b(\d+)\s*[- ]?\s*(?:count|ct|pieces|pcs)\b/i);
  return count && Number(count[1]) > 1 ? `${Number(count[1])} count` : '';
}
function withoutSizeAndCount(value) {
  return text(value)
    .replace(/\b(?:pack|case|set)\s*(?:of\s*)?\d+\b/gi, '')
    .replace(/\b\d+\s*[- ]?\s*(?:packs?|pk|count|ct|pieces|pcs)\b/gi, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:fl\.?\s*)?(?:ounces?|oz|ml|liters?|lb|grams?|kg|g)\b/gi, '')
    .replace(/[()\[\]]/g, '').replace(/\s+/g, ' ')
    .replace(/^[\s,·:|–—-]+|[\s,·:|–—-]+$/g, '').trim();
}
export function receiveVariant({ variant, aspects, title } = {}) {
  const value = withoutSizeAndCount(meaningful(variant) || aspect(aspects,
    ['scent', 'flavor', 'flavour', 'fragrance', 'variant', 'style']));
  const at = value ? text(title).toLowerCase().indexOf(value.toLowerCase()) : -1;
  return at >= 0 ? text(title).slice(at, at + value.length) : value;
}
export function receiveSpecifics(identity = {}) {
  const { brand, title, model, aspects = {}, size, unit_count } = identity;
  const variant = receiveVariant(identity);
  let type = text(title);
  const b = text(brand);
  if (b && type.toLowerCase().startsWith(b.toLowerCase())) type = type.slice(b.length).trim();
  const code = text(model);
  const isCode = value => /\d/.test(value) && !/\s/.test(value);
  if (code && isCode(code)) type = type.replaceAll(code, '');
  type = withoutSizeAndCount(type).split(/[|]/)[0].trim();
  if (isCode(type)) type = '';
  // An older confirmed human description is useful if a catalog title is absent.
  const fallback = code && !isCode(code) ? withoutSizeAndCount(code) : '';
  const base = variant || type || fallback || aspect(aspects, ['item form', 'product type', 'color']);
  const explicit = Number(aspect(aspects, ['number of items', 'item package quantity', 'package quantity']));
  const packages = Math.max(Number.isInteger(explicit) ? explicit : 1, Number.isInteger(unit_count) ? unit_count : 1);
  const count = packages > 1 ? `${packages} pack` : countIn(size) || countIn(title) || countIn(model);
  return [base, count].filter(Boolean).join(' · ').slice(0, 150);
}
