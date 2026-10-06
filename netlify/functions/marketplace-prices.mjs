import { corsHeaders, json, serviceClient } from '../lib/server.mjs';
import { connectionAdminFromEvent } from '../lib/server.mjs';
import { calcListPrice, estimateLabelCost, getFeeConfig } from '../lib/marketplace-pricing.mjs';
import { wrapHandler } from '../lib/floor-log.mjs';

const DEFAULT_MARKUP_CENTS = 200;
const specsOf = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

async function handle(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });
  try {
    const { staff } = await connectionAdminFromEvent(event, ['owner', 'manager', 'staff']);
    const sb = serviceClient();
    const { data: setting, error: settingError } = await sb.from('store_settings').select('value')
      .eq('store_id', staff.store_id).eq('key', 'marketplace_packing_markup_cents').maybeSingle();
    if (settingError) throw settingError;
    const globalMarkup = Number(setting?.value ?? DEFAULT_MARKUP_CENTS);
    if (event.queryStringParameters?.config === '1') {
      return json(200, { packing_markup_cents: Number.isFinite(globalMarkup) ? globalMarkup : DEFAULT_MARKUP_CENTS,
        fee_config_updated_at: getFeeConfig().updatedAt });
    }
    const sku = String(event.queryStringParameters?.sku || '').trim();
    if (!/^\d{5}$/.test(sku)) return json(400, { error: 'invalid_sku' });
    const { data: unit, error } = await sb.from('units')
      .select('sku,title,brand,model,category,ask_cents,package_weight_lb,package_weight_oz,package_length_in,package_width_in,package_height_in,listing_specs')
      .eq('store_id', staff.store_id).eq('sku', sku).maybeSingle();
    if (error) throw error;
    if (!unit) return json(404, { error: 'unit_not_found' });
    const floorCents = Number(unit.ask_cents);
    if (!Number.isSafeInteger(floorCents) || floorCents < 0) return json(409, { error: 'unit_unpriced' });
    const specs = specsOf(unit.listing_specs);
    const override = specs.marketplace_packing_markup_cents;
    const markup = override == null ? globalMarkup : Number(override);
    const label = estimateLabelCost(unit);
    const prices = Object.fromEntries(['ebay', 'mercari', 'whatnot', 'depop', 'website']
      .map((channel) => [channel, calcListPrice(floorCents, channel, label.labelCostCents, markup)]));
    return json(200, {
      sku: unit.sku,
      floor_cents: floorCents,
      label_estimate_cents: label.labelCostCents,
      label_is_estimate: label.isEstimate,
      missing_package_data: label.missingPackageData,
      packing_markup_cents: markup,
      global_packing_markup_cents: Number.isFinite(globalMarkup) ? globalMarkup : DEFAULT_MARKUP_CENTS,
      unit_packing_markup_cents: override == null ? null : Number(override),
      fee_config_updated_at: getFeeConfig().updatedAt,
      prices,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'not_signed_in' ? 401 : message === 'not_owner' || message === 'not_staff' ? 403 : 500;
    return json(status, { error: status === 500 ? 'marketplace_pricing_unavailable' : message });
  }
}

export const handler = wrapHandler('marketplace-prices', handle);
