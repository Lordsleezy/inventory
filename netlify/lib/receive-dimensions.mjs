import { readFloorProduct } from './floor-products.mjs';
import { normalizeGtin } from './gtin-normalize.mjs';
import { lookupUpc } from './upc-lookup.mjs';
import { comparablePrices } from './receive-price.mjs';

const fields = ['product_height_in', 'product_width_in', 'product_depth_in', 'product_weight_lb',
  'package_length_in', 'package_width_in', 'package_height_in', 'package_weight_lb'];
const num = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };

export function mergeDimensions(floor, amazon, upcitemdb) {
  const values = Object.fromEntries(fields.map(field => [field, null]));
  const sources = {};
  const put = (field, value, source) => {
    if (values[field] == null && num(value) != null) {
      values[field] = num(value);
      sources[field] = source;
    }
  };
  for (const [field, key] of [['product_height_in','height_in'],['product_width_in','width_in'],
    ['product_depth_in','length_in'],['product_weight_lb','weight_lb']])
    put(field, amazon?.item?.[key], 'Amazon');
  for (const [field, key] of [['package_length_in','length_in'],['package_width_in','width_in'],
    ['package_height_in','height_in'],['package_weight_lb','weight_lb']]) {
    put(field, amazon?.package?.[key], 'Amazon');
    put(field, upcitemdb?.package?.[key], 'UPCitemdb');
  }
  for (const field of fields) {
    const storedSource = floor?.dim_sources?.[field.replace(/^package_/, '')] || floor?.dim_sources?.[field];
    if (/estimat|\bai\b|gemini/i.test(String(storedSource || ''))) continue;
    const floorValue = field.startsWith('product_') ? floor?.aspects?.[field] : floor?.[field];
    put(field, floorValue, 'Floor');
  }
  // Product measurements cannot establish shipping-carton dimensions or weight.
  return { values, sources };
}

export function dimensionIdentityMatches(catalog, identity) {
  if (!identity?.title || !identity?.brand) return true;
  return comparablePrices([{price_cents:1, url:'https://catalog.example/item',
    product_name:[catalog?.title,catalog?.model].filter(Boolean).join(' ')}], identity).length > 0;
}

export async function lookupReceiveDimensions(sb, storeId, rawUpc, identity, { source = 'all' } = {}) {
  const gtin = normalizeGtin(rawUpc);
  if (!gtin.ok) return mergeDimensions(null, null, null);
  let floor = await readFloorProduct(sb, gtin.gtin14);
  if (!dimensionIdentityMatches(floor, identity)) floor = null;
  const catalog = await lookupUpc(storeId, rawUpc, { dimensionsOnly: true, deps: { sb,
    ...(source === 'amazon' ? {upcitemdb:async()=>({found:false})} : {}),
    ...(source === 'upcitemdb' ? {catalogByIdentifier:async()=>({found:false})} : {}),
  } });
  const reference = identity?.title ? identity : catalog.upcitemdb?.found
    ? { title:catalog.upcitemdb.title, brand:catalog.upcitemdb.brand } : null;
  const warnings = [];
  for (const source of ['amazon','upcitemdb']) {
    if (catalog[source]?.raw_error) warnings.push(`${source === 'amazon' ? 'Amazon' : 'UPCitemdb'} measurements unavailable; enter missing measurements manually.`);
    if (catalog[source]?.found && !dimensionIdentityMatches(catalog[source], reference)) {
      warnings.push(`${source === 'amazon' ? 'Amazon' : 'UPCitemdb'} measurements rejected: product size, count or identity did not match.`);
      catalog[source] = null;
    }
  }
  return { ...mergeDimensions(floor, catalog.amazon, catalog.upcitemdb), warnings };
}
