import { readFloorProduct } from './floor-products.mjs';
import { normalizeGtin } from './gtin-normalize.mjs';
import { lookupUpc } from './upc-lookup.mjs';

const fields = ['product_height_in', 'product_width_in', 'product_depth_in', 'product_weight_lb',
  'package_length_in', 'package_width_in', 'package_height_in', 'package_weight_lb'];
const num = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };
const round = value => Math.ceil(value * 10) / 10;

export function mergeDimensions(floor, amazon, upcitemdb, { estimate = true } = {}) {
  const values = Object.fromEntries(fields.map(field => [field, null]));
  const sources = {};
  const put = (field, value, source) => {
    if (values[field] == null && num(value) != null) {
      values[field] = num(value);
      sources[field] = source;
    }
  };
  for (const field of fields) {
    const floorValue = field.startsWith('product_') ? floor?.aspects?.[field] : floor?.[field];
    put(field, floorValue, 'Floor');
  }
  for (const [field, key] of [['product_height_in','height_in'],['product_width_in','width_in'],
    ['product_depth_in','length_in'],['product_weight_lb','weight_lb']])
    put(field, amazon?.item?.[key], 'Amazon');
  for (const [field, key] of [['package_length_in','length_in'],['package_width_in','width_in'],
    ['package_height_in','height_in'],['package_weight_lb','weight_lb']]) {
    put(field, amazon?.package?.[key], 'Amazon');
    put(field, upcitemdb?.package?.[key], 'UPCitemdb');
  }
  // A padded carton is a shipping estimate, not a claimed catalog measurement.
  if (estimate) {
    put('package_length_in', values.product_depth_in && round(values.product_depth_in + 2), 'estimated');
    put('package_width_in', values.product_width_in && round(values.product_width_in + 2), 'estimated');
    put('package_height_in', values.product_height_in && round(values.product_height_in + 2), 'estimated');
    put('package_weight_lb', values.product_weight_lb && round(values.product_weight_lb * 1.1), 'estimated');
  }
  return { values, sources };
}

export async function lookupReceiveDimensions(sb, storeId, rawUpc) {
  const gtin = normalizeGtin(rawUpc);
  if (!gtin.ok) return mergeDimensions(null, null, null);
  const floor = await readFloorProduct(sb, gtin.gtin14);
  const owned = mergeDimensions(floor, null, null, { estimate: false });
  if (fields.every(field => owned.values[field] != null)) return owned;
  const catalog = await lookupUpc(storeId, rawUpc, { dimensionsOnly: true, deps: { sb } });
  return mergeDimensions(floor, catalog.amazon, catalog.upcitemdb);
}
