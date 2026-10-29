/**
 * Receive barcode-miss fallback: one product photo → Gemini identify + asking-price median.
 * POST { upc?, image_base64, mime_type? }
 * Does not set a selling price — returns median/range for the user to choose.
 */
import { randomUUID } from 'node:crypto';
import { asNetlifyFunction, floorLog } from "../lib/floor-log.mjs";
import { json, optionsOk, serviceClient } from "../lib/server.mjs";
import { receiveAccessFromEvent, staffOwnsReceivedSkus } from "../lib/receive-auth.mjs";
import { identifyFrames, lookupRetail, tokenCost } from "../lib/video-scan.mjs";
import { medianReference, upcOfferPrices } from "../lib/receive-price.mjs";
import { upcitemdbLookup } from "../lib/upc-lookup.mjs";
import { receiveBrowsePrices } from "../lib/ebay-catalog.mjs";
import { lookupReceiveDimensions } from "../lib/receive-dimensions.mjs";
import { receiveSpecifics } from '../../shared/receive-specifics.mjs';
import { normalizeGtin } from "../lib/gtin-normalize.mjs";
import { searchCatalogAsin, catalogItemByIdentifier } from "../lib/amazon.mjs";
import { dimensionIdentityMatches } from "../lib/receive-dimensions.mjs";
import { isCompleteReceiveTitle, isNoBrand, receivePhotoIdentity } from "../../shared/store-barcode.mjs";
import {
  attachPhotoIdentityToMiss,
  listingTitle,
  saveFloorProduct,
} from "../lib/floor-products.mjs";
const receiveModel = () => process.env.GEMINI_RECEIVE_MODEL || 'gemini-3.5-flash-lite';
const retailModel = () => process.env.GEMINI_RETAIL_MODEL || 'gemini-3.1-flash-lite-preview';

function specificsFromIdentity(identity) {
  return receiveSpecifics(identity);
}

async function budgetError(ctx) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [settings, spend] = await Promise.all([
    ctx.sb.from('video_scan_settings').select('monthly_cap_usd').eq('store_id', ctx.storeId).maybeSingle(),
    ctx.sb.from('video_scan_jobs').select('estimated_cost_usd, reserved_usd')
      .eq('store_id', ctx.storeId).gte('created_at', monthStart.toISOString()),
  ]);
  if (settings.error || spend.error) {
    await floorLog({ level: 'error', event: 'receive_photo.budget_check_failed', message: String(settings.error?.message || spend.error?.message), storeId: ctx.storeId });
    return json(503, { ok: false, error: 'budget_check_failed', message: 'AI spend could not be checked. Retry or fill the fields by hand.' });
  }
  const cap = Number(settings.data?.monthly_cap_usd ?? 30);
  const spent = (spend.data || []).reduce((n, row) => n + Number(row.estimated_cost_usd || 0) + Number(row.reserved_usd || 0), 0);
  if (spent < cap) return null;
  return json(402, { ok: false, error: 'budget_exhausted',
    message: ctx.isAdmin
      ? `AI scan budget reached ($${spent.toFixed(2)} / $${cap.toFixed(2)}). Raise the cap under More → AI scan budget, or fill fields by hand.`
      : 'The monthly AI scan limit has been reached. Fill the fields by hand or ask an admin for help.' });
}

function photoFill(identity, brand, model, title) {
  return { brand, model, title, category: identity.category || '', description: identity.description || '',
    aspects: { ...(identity.variant ? { Variant: identity.variant } : {}),
      ...(identity.size ? { Size: identity.size } : {}),
      ...(identity.color ? { Color: identity.color } : {}), ...(brand ? { Brand: brand } : {}) } };
}

function photoSpecifics(identity) {
  const parts = [identity.item_type, identity.pattern, identity.variant, identity.size, identity.color]
    .map(value => String(value || '').trim()).filter(Boolean);
  const unique = [];
  for (const part of parts) if (!unique.some(value => value.toLowerCase().includes(part.toLowerCase())
    || part.toLowerCase().includes(value.toLowerCase()))) unique.push(part);
  return unique.join(', ');
}

function completePhotoTitle(identity, brand, model) {
  if (!String(identity.item_type || '').trim()) return '';
  const specifics = photoSpecifics(identity) || model;
  const supplied = String(identity.title || '').trim();
  if (isCompleteReceiveTitle(supplied, brand) && supplied.toLowerCase().includes(String(identity.item_type).toLowerCase())) return supplied;
  const composed = [isNoBrand(brand) ? '' : brand, specifics].filter(Boolean).join(' ').trim();
  return isCompleteReceiveTitle(composed, brand) ? composed : '';
}

async function logUsage(ctx, identity, usage, costUsd) {
  const { error } = await ctx.sb.from('video_scan_jobs').insert({
    store_id: ctx.storeId, created_by: ctx.userId, status: 'discarded',
    video_path: `receive-photo/${ctx.storeId}/${Date.now()}.jpg`, still_paths: [],
    result: { identity: { ...identity, receive_photo: true }, usage },
    estimated_cost_usd: costUsd, reserved_usd: 0, search_queries: usage.search_queries || 0,
    error: null, updated_at: new Date().toISOString(),
  });
  if (error) await floorLog({ level: 'error', event: 'receive_photo.spend_log_failed', message: error.message, storeId: ctx.storeId });
}

export async function invoke(event) {
  if (event.httpMethod === "OPTIONS") return optionsOk();
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST required" });

  const body = JSON.parse(event.body || "{}");
  const ctx = await receiveAccessFromEvent(event, body.store_id);
  if (body.action === 'stage_stock_photo') {
    const gtin = normalizeGtin(String(body.upc || '').trim());
    const requestId = String(body.request_id || '');
    if (!gtin.ok || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId))
      return json(400, { ok: false, error: 'valid_upc_and_request_required' });
    let photoUrl;
    try {
      photoUrl = new URL(String(body.url || ''));
    } catch { return json(400, { ok: false, error: 'catalog_photo_required' }); }
    const host = photoUrl.hostname.toLowerCase();
    const imageHostAllowed = ['media-amazon.com', 'ssl-images-amazon.com', 'scene7.com', 'target.com',
      'upcitemdb.com', 'walmartimages.com', 'salsify.com', 'ebayimg.com', 'bestbuy.com', 'homedepot.com']
      .some(domain => host === domain || host.endsWith(`.${domain}`));
    if (photoUrl.protocol !== 'https:' || !imageHostAllowed || photoUrl.username || photoUrl.password)
      return json(400, { ok: false, error: 'unsupported_catalog_photo' });
    const [product, cached] = await Promise.all([
      ctx.sb.from('floor_products').select('images').eq('gtin14', gtin.gtin14).maybeSingle(),
      ctx.sb.from('upc_lookup_cache').select('payload').eq('gtin14', gtin.gtin14).maybeSingle(),
    ]);
    const payload = cached.data?.payload || {};
    const permittedUrls = [
      ...(product.data?.images || []), ...(payload.merged?.images || []),
      ...(payload.amazon?.images || []), ...(payload.upcitemdb?.images || []),
    ];
    if (!permittedUrls.includes(photoUrl.href)) return json(403, { ok: false, error: 'catalog_photo_mismatch' });
    try {
      const response = await fetch(photoUrl, { redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg' } });
      const mime = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' })[mime];
      if (!response.ok || !ext) throw new Error('catalog_photo_unavailable');
      const maxBytes = 8 * 1024 * 1024;
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > maxBytes) throw new Error('catalog_photo_too_large');
      const chunks = [];
      let total = 0;
      if (!response.body) throw new Error('catalog_photo_empty');
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) throw new Error('catalog_photo_too_large');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, total);
      if (bytes.length < 2048 || bytes.length > 8 * 1024 * 1024) throw new Error('catalog_photo_size_invalid');
      const path = `${ctx.storeId}/receive/${ctx.userId}/${requestId}/stock-${randomUUID()}.${ext}`;
      const { error } = await ctx.sb.storage.from('unit-photos').upload(path, bytes,
        { contentType: mime, upsert: false });
      if (error) throw error;
      return json(200, { ok: true, path });
    } catch (error) {
      await floorLog({ level: 'warn', event: 'receive_photo.stock_stage_failed', storeId: ctx.storeId,
        message: String(error?.message || error).slice(0, 160) });
      return json(502, { ok: false, error: 'catalog_photo_unavailable', message: 'Stock photo could not be saved. Add a unit photo to continue.' });
    }
  }
  if (body.action === 'confirm') {
    const gtin = normalizeGtin(String(body.upc || '').trim());
    if (!gtin.ok) return json(400, { ok: false, error: 'valid_upc_required' });
    const fields = receivePhotoIdentity(body.fields || {});
    const brand = String(fields.brand || '').trim().slice(0, 120);
    const title = String(fields.title || '').trim().slice(0, 250);
    if (!brand || !title) return json(400, { ok: false, error: 'product_details_required' });
    const cleanMeasure = value => { const n = Number(value); return Number.isFinite(n) && n > 0 && n < 10000 ? n : null; };
    const skus = Array.isArray(body.skus) ? body.skus.map(String).filter(Boolean).slice(0, 100) : [];
    if (!await staffOwnsReceivedSkus(ctx, skus))
      return json(403, { ok: false, error: 'received_unit_access_required' });
    const { data: existing } = await ctx.sb.from('floor_products').select('*').eq('gtin14', gtin.gtin14).maybeSingle();
    const productDimensions = Object.fromEntries(
      ['product_height_in', 'product_width_in', 'product_depth_in', 'product_weight_lb']
        .map(key => [key, cleanMeasure(fields[key])]).filter(([, value]) => value != null),
    );
    const aspects = { ...(existing?.aspects || {}), ...(fields.aspects && typeof fields.aspects === 'object' ? fields.aspects : {}) };
    const dimensionSources = fields.dimension_sources && typeof fields.dimension_sources === 'object'
      ? fields.dimension_sources : {};
    for (const [key, value] of Object.entries(productDimensions)) aspects[key] = String(value);
    const saved = await saveFloorProduct(ctx.sb, gtin, {
      brand, title, model: String(fields.model || '').trim().slice(0, 150),
      category: String(fields.category || existing?.category || '').trim().slice(0, 150),
      description: String(fields.description || existing?.description || '').trim().slice(0, 2000),
      aspects,
      features: existing?.features || [], asin: existing?.asin || null, images: existing?.images || [],
      package: {
        length_in: cleanMeasure(fields.length_in) || existing?.package_length_in,
        width_in: cleanMeasure(fields.width_in) || existing?.package_width_in,
        height_in: cleanMeasure(fields.height_in) || existing?.package_height_in,
        weight_lb: cleanMeasure(fields.weight_lb) || existing?.package_weight_lb,
      },
    }, { source: body.source === 'photo' ? 'photo' : 'manual', actorId: ctx.userId,
      dimSources: { ...(existing?.dim_sources || {}),
        ...Object.fromEntries(['length_in','width_in','height_in','weight_lb'].filter(k => cleanMeasure(fields[k]))
          .map(k => [k, String(dimensionSources[`package_${k}`] || 'staff_entered').slice(0, 50)])) } });
    if (skus.length && Object.keys(productDimensions).length) {
      const productSource = Object.keys(productDimensions).some(k => dimensionSources[k] === 'estimated') ? 'estimated' : 'verified';
      const { error } = await ctx.sb.from('units').update({ ...productDimensions, dims_source: productSource })
        .eq('store_id', ctx.storeId).eq('upc', String(body.upc || '').trim()).in('sku', skus);
      if (error) await floorLog({ level: 'warn', event: 'receive_photo.measure_save_failed', message: error.message, storeId: ctx.storeId });
    }
    return saved ? json(200, { ok: true, gtin14: gtin.gtin14 }) : json(500, { ok: false, error: 'product_save_failed', message: 'The unit was saved, but its UPC product details could not be cached.' });
  }
  if (body.action === 'confirm_identity') {
    const gtin = normalizeGtin(String(body.upc || '').trim());
    if (!gtin.ok) return json(400, { ok: false, error: 'valid_upc_required' });
    const fields = receivePhotoIdentity(body.fields || {});
    const brand = String(fields.brand || '').trim().slice(0, 120);
    const title = String(fields.title || '').trim().slice(0, 250);
    const itemType = String(fields.item_type || '').trim().slice(0, 100);
    const model = String(fields.model || '').trim().slice(0, 180);
    if (!brand || !itemType || !title.toLowerCase().includes(itemType.toLowerCase()) || !isCompleteReceiveTitle(title, brand))
      return json(422, { ok: false, error: 'complete_product_title_required', message: 'Enter what the item is plus color, size or material. Choose No brand for an unbranded item.' });

    // Search by the photo-confirmed identity, never by a suspected retailer code.
    // Persist images only when Amazon returns a matching brand/title candidate.
    let matched = null;
    try {
      const candidate = isNoBrand(brand) ? null : await searchCatalogAsin(ctx.storeId, { upc: '', brand, model, title });
      const summary = { brand: candidate?.brand || '', title: candidate?.title || '' };
      const requested = { brand, title, model, size: fields.size || '', variant: fields.variant || '', color: fields.color || '' };
      if (candidate?.asin && dimensionIdentityMatches(summary, requested)) {
        const detail = await catalogItemByIdentifier(ctx.storeId, 'ASIN', candidate.asin);
        if (detail?.found && dimensionIdentityMatches(detail.item, requested)) matched = detail.item;
      }
    } catch (error) {
      await floorLog({ level: 'warn', event: 'receive_photo.confirmed_catalog_unavailable',
        message: String(error?.message || error).slice(0, 180), storeId: ctx.storeId });
    }
    const aspects = { ...(fields.aspects && typeof fields.aspects === 'object' ? fields.aspects : {}) };
    for (const key of ['size', 'color', 'variant']) if (fields[key])
      aspects[key === 'size' ? 'Size' : key === 'color' ? 'Color' : 'Variant'] = String(fields[key]).slice(0, 100);
    const saved = await saveFloorProduct(ctx.sb, gtin, {
      brand, title, model, category: String(fields.category || '').trim().slice(0, 150),
      description: String(fields.description || '').trim().slice(0, 2000),
      aspects: { ...(matched?.aspects || {}), ...aspects },
      features: matched?.features || [], asin: matched?.asin || null,
      images: matched?.images || [], package: matched?.package || {},
    }, { source: 'photo', actorId: ctx.userId,
      dimSources: matched ? { length_in: 'Amazon', width_in: 'Amazon', height_in: 'Amazon', weight_lb: 'Amazon' } : {} });
    if (!saved) return json(500, { ok: false, error: 'product_save_failed', message: 'Could not save the confirmed product to the UPC catalog.' });
    return json(200, { ok: true, gtin14: gtin.gtin14, product: {
      brand, title, model, category: String(fields.category || ''), images: saved.images || [],
      stock_photo_found: Boolean(saved.images?.length), asin: saved.asin || null,
    } });
  }
  if (body.action === 'dimensions') {
    const started = Date.now();
    try {
      const dimensions = await lookupReceiveDimensions(ctx.sb, ctx.storeId, String(body.upc || '').trim(), body.identity,
        { source: ['amazon','upcitemdb'].includes(body.source) ? body.source : 'all' });
      await floorLog({ level: 'info', event: 'receive_photo.dimension_sources', storeId: ctx.storeId,
        detail: { sources: dimensions.sources, fields: Object.keys(dimensions.sources).length, elapsed_ms: Date.now() - started } });
      return json(200, { ok: true, dimensions, timing: { dims_ms: Date.now() - started } });
    } catch (error) {
      await floorLog({ level: 'warn', event: 'receive_photo.dimensions_failed', message: String(error?.message || error).slice(0, 200), storeId: ctx.storeId });
      return json(502, { ok: false, message: 'Dimensions could not be found right now. You can still save this item.' });
    }
  }
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (body.action !== 'prices' && (!apiKey || /\*{3,}/.test(apiKey))) {
    await floorLog({ level: 'error', event: 'receive_photo.key_unavailable', message: 'Production GEMINI_API_KEY is empty or masked', storeId: ctx.storeId });
    return json(503, { ok: false, error: 'photo_identification_unavailable', message: 'Photo identification is temporarily unavailable. Retry or fill the fields by hand.' });
  }
  if (body.action === 'prices') {
    if (!['upcitemdb', 'ebay'].includes(body.source)) {
      const denied = await budgetError(ctx);
      if (denied) return denied;
    }
    const source = body.identity || {};
    const identity = Object.fromEntries(['title', 'brand', 'model', 'variant', 'size', 'color', 'upc']
      .map(key => [key, String(source[key] || '').slice(0, 200)]));
    if (!identity.title || !identity.brand) return json(400, { ok: false, error: 'product_identity_required' });
    const started = Date.now();
    try {
      identity.unit_count = Math.max(1, Number(source.unit_count) || 1);
      const sourceName = ['upcitemdb', 'ebay', 'gemini'].includes(body.source) ? body.source : 'gemini';
      let recorded;
      if (sourceName === 'upcitemdb' && /^\d{8,14}$/.test(identity.upc)) {
        recorded = await upcitemdbLookup(identity.upc);
        if (recorded.raw_error) throw new Error(recorded.raw_error);
      }
      const retail = sourceName === 'upcitemdb'
        ? { prices: upcOfferPrices(recorded, identity) }
        : sourceName === 'ebay' ? { prices: await receiveBrowsePrices(identity) }
        : await lookupRetail(ctx.sb, { store_id: ctx.storeId }, identity, { singlePass: true, exactMatch: true });
      const reference = medianReference(retail.prices || [], identity);
      await floorLog({ level: 'info', event: 'receive_photo.price_source', storeId: ctx.storeId,
        message: `${sourceName}: ${reference.count ? 'hit' : 'empty'}`,
        detail: { source: sourceName, count: reference.count, elapsed_ms: Date.now() - started } });
      const costUsd = tokenCost(retail.input || 0, retail.output || 0, retailModel());
      if (sourceName === 'gemini') await logUsage(ctx, identity, { price_input_tokens: retail.input || 0, price_output_tokens: retail.output || 0,
        search_queries: retail.queries || 0 }, costUsd);
      return json(200, { ok: true, price: reference,
        timing: { price_ms: Date.now() - started }, cost_usd: costUsd });
    } catch (e) {
      await floorLog({ level: 'warn', event: 'receive_photo.retail_fail', message: String(e?.message || e).slice(0, 300),
        detail: { source: body.source || 'gemini', outcome: 'error', elapsed_ms: Date.now() - started }, storeId: ctx.storeId });
      return json(502, { ok: false, error: 'price_lookup_failed', message: 'Online prices could not be found right now. Enter your price by hand.' });
    }
  }
  const rawB64 = String(body.image_base64 || "").replace(/^data:[^;]+;base64,/, "");
  if (!rawB64 || rawB64.length < 100) return json(400, { ok: false, error: "image_required" });

  let bytes;
  try {
    bytes = Buffer.from(rawB64, 'base64');
    // The browser sends a downscaled JPEG. Validate the format and cap bytes here
    // so this endpoint does not load a platform-native image library in Lambda.
    if (bytes.length < 2048 || bytes.length > 6 * 1024 * 1024 ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('invalid_jpeg');
  } catch {
    return json(400, { ok: false, error: 'invalid_image', message: 'That photo could not be read. Try one clear JPEG photo or fill the fields by hand.' });
  }

  const upc = String(body.upc || "").trim();
  const gtin = upc ? normalizeGtin(upc) : { ok: false };
  const t0 = Date.now();

  const denied = await budgetError(ctx);
  if (denied) return denied;

  let identified;
  try {
    identified = await identifyFrames([bytes], { modelName: receiveModel(), maxOutputTokens: 1100, receivePhoto: true });
  } catch (e) {
    const upstream = String(e?.message || e).slice(0, 400);
    await floorLog({ level: 'error', event: 'receive_photo.identify_failed', message: upstream, storeId: ctx.storeId,
      detail: { elapsed_ms: Date.now() - t0, gemini_model: receiveModel() } });
    const status = /Gemini 401|Gemini 403|API key|PERMISSION_DENIED/i.test(upstream) ? 502 : /Gemini 429|RESOURCE_EXHAUSTED/i.test(upstream) ? 429 : 502;
    const message = status === 429 ? 'Photo identification is busy at the AI provider. Retry once or fill the fields by hand.'
      : /Gemini 404|model.*not found/i.test(upstream) ? 'The photo model is unavailable. Retry later or fill the fields by hand.'
      : /Gemini 401|Gemini 403|API key|PERMISSION_DENIED/i.test(upstream) ? 'The AI provider rejected the configured key. Retry later or fill the fields by hand.'
      : `Photo identification failed: ${upstream.replace(/Gemini \d+:\s*/, '').slice(0, 160)}. Retry or fill the fields by hand.`;
    return json(status, { ok: false, error: 'photo_identification_failed', message, upstream_error: upstream });
  }
  const identity = receivePhotoIdentity(identified.result || {});
  const brand = String(identity.brand || "").trim();
  const model = photoSpecifics(identity) || specificsFromIdentity(identity);
  const title = completePhotoTitle(identity, brand, model) || listingTitle(brand, model);
  const titleComplete = Boolean(completePhotoTitle(identity, brand, model));
  const identifyMs = Date.now() - t0;

  if (body.action === 'identify_only') {
    const costUsd = tokenCost(identified.input || 0, identified.output || 0, receiveModel());
    await logUsage(ctx, { ...identity, title, brand, model },
      { identify_input_tokens: identified.input || 0, identify_output_tokens: identified.output || 0,
        search_queries: 0 }, costUsd);
    if (gtin.ok) await attachPhotoIdentityToMiss(ctx.sb, {
      gtin14: gtin.gtin14, identity: { brand, model, title, confidence: identity.confidence, upc },
      missId: body.miss_id || null,
    });
    await floorLog({ level: 'info', event: 'receive_photo.identified', message: title || brand,
      storeId: ctx.storeId, detail: { upc, identify_ms: identifyMs, cost_usd: costUsd } });
    return json(200, { ok: true,
      identity: { ...identity, brand, model, title, title_complete: titleComplete },
      fill: photoFill(identity, brand, model, titleComplete ? title : ''), timing: { identify_ms: identifyMs }, cost_usd: costUsd });
  }

  // Price lookup in parallel spirit: start after name is known; user can see name first client-side
  // when we stream — for now one response with both.
  const job = { store_id: ctx.storeId };
  let prices = [];
  let retailMeta = { input: 0, output: 0, queries: 0, reused: false };
  try {
    retailMeta = await lookupRetail(ctx.sb, job, { ...identity, title, brand, model, upc }, { singlePass: true, exactMatch: true });
    prices = retailMeta.prices || [];
  } catch (e) {
    await floorLog({
      level: "warn",
      event: "receive_photo.retail_fail",
      message: String(e?.message || e).slice(0, 200),
      storeId: ctx.storeId,
    });
  }

  const reference = medianReference(prices, { ...identity, title, brand, model });

  const costUsd = tokenCost(identified.input || 0, identified.output || 0, receiveModel())
    + tokenCost(retailMeta.input || 0, retailMeta.output || 0, retailModel());
  // Record spend against video_scan_jobs so the existing AI scan budget UI counts this.
  await logUsage(ctx, { ...identity, title, brand, model },
    { identify_input_tokens: identified.input || 0, identify_output_tokens: identified.output || 0,
      price_input_tokens: retailMeta.input || 0, price_output_tokens: retailMeta.output || 0,
      search_queries: retailMeta.queries || 0 }, costUsd);

  if (gtin.ok) {
    await attachPhotoIdentityToMiss(ctx.sb, {
      gtin14: gtin.gtin14,
      identity: { brand, model, title, confidence: identity.confidence, upc },
      missId: body.miss_id || null,
    });
  }

  await floorLog({
    level: "info",
    event: "receive_photo.ok",
    message: title || brand || "identified",
    storeId: ctx.storeId,
    detail: { upc, identify_ms: identifyMs, total_ms: Date.now() - t0, prices: reference.count, cost_usd: costUsd },
  });

  return json(200, {
    ok: true,
    identity: {
      brand,
      model,
      title,
      title_complete: titleComplete,
      variant: identity.variant || '',
      size: identity.size || '',
      category: identity.category || '',
      description: identity.description || '',
      color: identity.color || "",
      confidence: identity.confidence ?? null,
      unit_count: identity.unit_count || 1,
      catalog_title: identity.title || "",
    },
    fill: photoFill(identity, brand, model, titleComplete ? title : ''),
    price: reference,
    timing: { identify_ms: identifyMs, total_ms: Date.now() - t0 },
    cost_usd: costUsd,
  });
}

export default asNetlifyFunction(invoke);
