import { readFloorProduct } from './floor-products.mjs';
import { normalizeGtin } from './gtin-normalize.mjs';
import { lookupUpc } from './upc-lookup.mjs';
import { comparablePrices } from './receive-price.mjs';
import { searchCatalogAsin, catalogItemByIdentifier } from './amazon.mjs';
import { isStoreLabelBarcode } from '../../shared/store-barcode.mjs';

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
    put(field, floorValue, storedSource || 'Floor');
  }
  // Product measurements cannot establish shipping-carton dimensions or weight.
  return { values, sources };
}

export function dimensionWarnings(values) {
  return Object.values(values).some(value => num(value) != null)
    ? [] : ['No size found. Measure on mat.'];
}

export function dimensionIdentityMatches(catalog, identity, { exactBarcode = false } = {}) {
  if (!identity?.title || !identity?.brand) return true;
  // Barcode catalogs often abbreviate marketing variants ("Linen" vs "Linen & Sky").
  // Keep size/count checks; don't require every marketing word on an exact-GTIN record.
  const matchIdentity = exactBarcode ? { ...identity, variant: undefined } : identity;
  const name = [catalog?.brand,catalog?.title,catalog?.model,catalog?.size,catalog?.aspects?.Size]
    .filter(Boolean).join(' ');
  if (!comparablePrices([{price_cents:1, url:'https://catalog.example/item', product_name:name}], matchIdentity).length) return false;
  const expectedSize = String(identity.size || '').trim();
  if (/(?:\bin\b|inch|\")/i.test(expectedSize)) {
    const measurements = expectedSize.match(/\d+(?:\.\d+)?/g) || [];
    const catalogName = String(name).toLowerCase();
    if (measurements.length >= 2 && !measurements.every(value =>
      new RegExp(`(?<!\\d)${value.replace('.', '\\.')}(?!\\d)`).test(catalogName))) return false;
  }
  return true;
}

export async function lookupReceiveDimensions(sb, storeId, rawUpc, identity, {
  source = 'all', searchCatalog = searchCatalogAsin, itemByIdentifier = catalogItemByIdentifier,
} = {}) {
  const gtin = normalizeGtin(rawUpc);
  if (!gtin.ok) return mergeDimensions(null, null, null);
  if (isStoreLabelBarcode(rawUpc)) {
    // Store labels are never dimension identifiers. Search by the confirmed
    // photo identity instead, and don't consult UPCitemdb for the sticker.
    if (source === 'upcitemdb' || !identity?.title || !identity?.brand) return mergeDimensions(null, null, null);
    try {
      const candidate = await searchCatalog(storeId, { upc: '', brand: identity.brand,
        title: identity.title, model: identity.model || '' });
      if (!candidate?.asin || !dimensionIdentityMatches(candidate, identity)) return mergeDimensions(null, null, null);
      const detail = await itemByIdentifier(storeId, 'ASIN', candidate.asin);
      if (!detail?.found || !dimensionIdentityMatches(detail.item, identity)) return mergeDimensions(null, null, null);
      return { ...mergeDimensions(null, detail.item, null), warnings: [] };
    } catch {
      return mergeDimensions(null, null, null);
    }
  }
  let floor = await readFloorProduct(sb, gtin.gtin14);
  if (!dimensionIdentityMatches(floor, identity, { exactBarcode: true })) floor = null;
  const catalog = await lookupUpc(storeId, rawUpc, { dimensionsOnly: true, deps: { sb,
    ...(source === 'amazon' ? {upcitemdb:async()=>({found:false})} : {}),
    ...(source === 'upcitemdb' ? {catalogByIdentifier:async()=>({found:false})} : {}),
  } });
  const reference = identity?.title ? identity : catalog.upcitemdb?.found
    ? { title:catalog.upcitemdb.title, brand:catalog.upcitemdb.brand } : null;
  const warnings = [];
  for (const source of ['amazon','upcitemdb']) {
    if (catalog[source]?.found && !dimensionIdentityMatches(catalog[source], reference, { exactBarcode: true })) {
      catalog[source] = null;
    }
  }
  const merged = mergeDimensions(floor, catalog.amazon, catalog.upcitemdb);
  return { ...merged, warnings: [...warnings, ...dimensionWarnings(merged.values)] };
}
