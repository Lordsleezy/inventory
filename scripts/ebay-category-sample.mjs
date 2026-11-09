// Read-only: compare recent inventory categories with eBay Taxonomy suggestions.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { catalogProductByGtin, suggestCategories } from '../netlify/lib/ebay-catalog.mjs';
import { presentCategorySuggestions } from '../shared/ebay-category-present.mjs';

const envPath = `${process.env.TEMP}\\netlify-env-inventoryobi.json`;
for (const row of JSON.parse(readFileSync(envPath, 'utf8'))) {
  const value = row.values?.[0]?.value;
  if (row.key && value) process.env[row.key] ||= value;
}

const STORE = '5487ca47-6147-4fe8-bc6d-46b6472726ba';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

function issueOf(row, tax) {
  if (!row?.category_id) return 'no category';
  if (!tax || tax.active !== true || tax.leaf !== true) return 'not a leaf category';
  if (!tax.fields_fetched_at) return 'specifics not checked';
  const fields = Array.isArray(tax.aspect_fields) ? tax.aspect_fields : [];
  const attrs = row.attributes || {};
  const missing = fields.filter((field) => field?.required && !String(attrs[field.name] || '').trim());
  if (missing.length) return 'missing required specifics';
  return '';
}

const units = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from('units')
    .select('sku,title,state,qty_on_hand,received_at,upc')
    .eq('store_id', STORE)
    .in('state', ['available', 'reserved', 'repair'])
    .gt('qty_on_hand', 0)
    .order('received_at', { ascending: false })
    .range(from, from + 999);
  if (error) throw error;
  units.push(...(data || []));
  if (!data || data.length < 1000) break;
}

const cats = [];
for (let i = 0; i < units.length; i += 200) {
  const skus = units.slice(i, i + 200).map((row) => row.sku);
  const { data, error } = await sb.from('unit_channel_categories')
    .select('sku,category_id,attributes')
    .eq('store_id', STORE).eq('channel', 'ebay').in('sku', skus);
  if (error) throw error;
  cats.push(...(data || []));
}
const bySku = new Map(cats.map((row) => [row.sku, row]));
const ids = [...new Set(cats.map((row) => row.category_id).filter(Boolean))];
const tax = new Map();
for (let i = 0; i < ids.length; i += 200) {
  const { data, error } = await sb.from('channel_taxonomy')
    .select('category_id,path,leaf,active,fields_fetched_at,aspect_fields')
    .eq('channel', 'ebay').in('category_id', ids.slice(i, i + 200));
  if (error) throw error;
  for (const row of data || []) tax.set(row.category_id, row);
}

const counts = {};
for (const unit of units) {
  const issue = issueOf(bySku.get(unit.sku), tax.get(bySku.get(unit.sku)?.category_id));
  if (!issue) continue;
  counts[issue] = (counts[issue] || 0) + 1;
}

const sample = [];
const seenCategory = new Set();
for (const unit of units) {
  const title = String(unit.title || '').trim();
  if (title.length < 8) continue;
  const savedId = bySku.get(unit.sku)?.category_id || '(none)';
  if (seenCategory.has(savedId)) continue;
  seenCategory.add(savedId);
  sample.push(unit);
  if (sample.length === 16) break;
}

const rows = [];
for (const unit of sample) {
  const saved = bySku.get(unit.sku);
  const savedTax = tax.get(saved?.category_id);
  let suggested = '';
  let match = 'no suggestion';
  try {
    const raw = await suggestCategories(titleOf(unit));
    const shown = presentCategorySuggestions(titleOf(unit), raw);
    suggested = shown[0] ? `${shown[0].category_name} (${shown[0].category_id})` : '(none sane)';
    match = shown.some((row) => row.category_id === String(saved?.category_id || '')) ? 'yes' : (saved?.category_id ? 'no' : 'unsaved');
  } catch (error) {
    suggested = `error: ${error.message}`;
    match = 'error';
  }
  rows.push({
    title: titleOf(unit).slice(0, 80),
    saved: savedTax?.path ? savedTax.path.split('>').slice(-2).join(' > ').trim() : (saved?.category_id || '(none)'),
    savedId: saved?.category_id || '',
    suggested,
    match,
  });
}

function titleOf(unit) { return String(unit.title || '').trim(); }

let catalog = null;
try { catalog = await catalogProductByGtin('829274513753'); }
catch (error) { catalog = { error: error.message }; }
const { data: products } = await sb.from('floor_products').select('gtin14,images').or('gtin14.eq.00829274513753,gtin14.eq.829274513753').limit(5);
for (const product of products || []) {
  product.imageHosts = (Array.isArray(product.images) ? product.images : []).slice(0, 3).map((url) => {
    try { return new URL(String(url)).host; } catch { return 'unreadable'; }
  });
  product.images = Array.isArray(product.images) ? product.images.length : 0;
}
const { data: upcUnits } = await sb.from('units').select('sku,title,has_stock_photos,upc').eq('store_id', STORE).eq('upc', '829274513753').limit(5);

console.log(JSON.stringify({
  inStock: units.length,
  needsFix: counts,
  sample: rows,
  upc: {
    catalogImages: Array.isArray(catalog?.imageUrls) ? catalog.imageUrls.length : 0,
    catalogCategoryId: catalog?.categoryId || null,
    catalogTitle: catalog?.title || catalog?.error || null,
    storedProducts: (products || []).map((row) => ({ gtin14: row.gtin14, images: row.images, hosts: row.imageHosts || [] })),
    units: upcUnits || [],
  },
}, null, 2));
