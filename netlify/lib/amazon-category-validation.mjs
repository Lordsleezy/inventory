import Ajv2019 from 'ajv/dist/2019.js';
import { serviceClient } from './server.mjs';
import { amazonConditionFromUnit, marketplaceId } from './amazon.mjs';

const validators = new Map();
export function amazonValidationFacts(unit) {
  return { condition: unit.condition ?? null, ask_cents: unit.ask_cents ?? null,
    qty_on_hand: unit.qty_on_hand ?? null, asin: unit.listing_specs?.asin ?? null };
}

export function amazonOfferAttributes(unit, values = {}, schema = {}, { asin, priceCents } = {}) {
  const market = marketplaceId();
  const attrs = {};
  for (const [name, raw] of Object.entries(values)) {
    if (raw == null || raw === '') continue;
    const property = schema.properties?.[name];
    let value = raw;
    if (typeof raw === 'string' && /^[\[{]/.test(raw.trim())) {
      try { value = JSON.parse(raw); } catch { /* Schema validation reports malformed structured values. */ }
    }
    if (Array.isArray(value)) { attrs[name] = value; continue; }
    const type = property?.items?.properties?.value?.type;
    if (type === 'boolean' && ['true', 'false'].includes(String(value))) value = String(value) === 'true';
    if (['number', 'integer'].includes(type) && String(value).trim() && Number.isFinite(Number(value))) value = Number(value);
    attrs[name] = [{ value, marketplace_id: market,
      ...(property?.items?.properties?.language_tag ? { language_tag: 'en_US' } : {}) }];
  }
  const condition = amazonConditionFromUnit(unit);
  if (condition.confident && condition.amazon) attrs.condition_type = [{ value: condition.amazon, marketplace_id: market }];
  if (condition.note) attrs.condition_note = [{ value: condition.note.slice(0, 1000), marketplace_id: market, language_tag: 'en_US' }];
  const matchedAsin = asin || unit.listing_specs?.asin;
  if (matchedAsin) attrs.merchant_suggested_asin = [{ value: matchedAsin, marketplace_id: market }];
  attrs.fulfillment_availability = [{ fulfillment_channel_code: 'DEFAULT', quantity: 1 }];
  const cents = priceCents ?? unit.ask_cents;
  if (Number(cents) > 0) attrs.purchasable_offer = [{ currency: 'USD', marketplace_id: market,
    our_price: [{ schedule: [{ value_with_tax: Number((Number(cents) / 100).toFixed(2)) }] }] }];
  return attrs;
}

export function validateAmazonAttributes(schema, version, attributes) {
  let validate = validators.get(version);
  if (!validate) {
    // Amazon's metadata vocabulary contains annotation keywords. Standard JSON Schema
    // requirements, conditionals, types, enums, and nested constraints remain enforced.
    const ajv = new Ajv2019({ strict: false, allErrors: true, validateSchema: false, validateFormats: false, logger: false });
    const compiledSchema = { ...schema };
    delete compiledSchema.$schema;
    validate = ajv.compile(compiledSchema);
    if (validators.size > 30) validators.clear();
    validators.set(version, validate);
  }
  if (validate(attributes)) return [];
  const errors = new Map();
  for (const error of validate.errors || []) {
    if (['if', 'anyOf', 'oneOf', 'contains'].includes(error.keyword)) continue;
    const name = error.instancePath.split('/').filter(Boolean)[0] || error.params.missingProperty || error.params.additionalProperty;
    if (!name) continue;
    const issue = error.keyword === 'required' ? `Amazon requires ${error.params.missingProperty}` : `Amazon ${error.message}`;
    errors.set(`${name}:${issue}`, { name, issue });
  }
  return errors.size ? [...errors.values()] : [{ name: null, issue: 'Amazon schema requirements incomplete' }];
}

export async function validateAmazonUnitCategory(storeId, sku) {
  const sb = serviceClient();
  const { data: row, error } = await sb.from('unit_channel_categories').select('*')
    .eq('store_id', storeId).eq('sku', sku).eq('channel', 'amazon').maybeSingle();
  if (error) throw new Error(error.message);
  if (!row?.enabled || !row.category_id) return;
  const [{ data: unit, error: unitError }, { data: category, error: categoryError }] = await Promise.all([
    sb.from('units').select('*').eq('store_id', storeId).eq('sku', sku).single(),
    sb.from('channel_taxonomy').select('validation_schema,fields_version').eq('channel', 'amazon').eq('category_id', row.category_id).maybeSingle(),
  ]);
  if (unitError || categoryError) throw new Error((unitError || categoryError).message);
  if (!category?.validation_schema || !category.fields_version) return;
  const attributes = amazonOfferAttributes(unit, row.attributes, category.validation_schema);
  const errors = validateAmazonAttributes(category.validation_schema, category.fields_version, attributes);
  const { error: saveError } = await sb.from('unit_channel_categories').update({
    validation_version: category.fields_version, validation_unit: amazonValidationFacts(unit),
    validation_attributes: row.attributes, validation_errors: errors,
  }).eq('store_id', storeId).eq('sku', sku).eq('channel', 'amazon').eq('category_id', row.category_id);
  if (saveError) throw new Error(saveError.message);
  return { attributes, errors };
}
