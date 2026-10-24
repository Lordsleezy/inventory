/**
 * Receive barcode-miss fallback: one product photo → Gemini identify + asking-price median.
 * POST { upc?, image_base64, mime_type? }
 * Does not set a selling price — returns median/range for the user to choose.
 */
import { asNetlifyFunction, floorLog } from "../lib/floor-log.mjs";
import { json, optionsOk, serviceClient } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { identifyFrames, lookupRetail, tokenCost } from "../lib/video-scan.mjs";
import { medianReference } from "../lib/receive-price.mjs";
import { itemSpecificsFromLookup, usableModelNumber, variantFromTitle } from "../lib/amazon.mjs";
import { normalizeGtin } from "../lib/gtin-normalize.mjs";
import {
  attachPhotoIdentityToMiss,
  listingTitle,
  saveFloorProduct,
} from "../lib/floor-products.mjs";

async function authFromEvent(event) {
  try {
    const storeIdHint = JSON.parse(event.body || '{}').store_id;
    return await portalAdminFromEvent(event, storeIdHint);
  } catch (adminErr) {
    if (adminErr?.status && adminErr.status !== 403) throw adminErr;
    const token = (event.headers?.authorization || event.headers?.Authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) throw Object.assign(new Error("Sign in required"), { status: 401 });
    const sb = serviceClient();
    const { data: auth, error } = await sb.auth.getUser(token);
    if (error || !auth.user) throw Object.assign(new Error("Sign in required"), { status: 401 });
    const { data: staff } = await sb
      .from("staff")
      .select("store_id")
      .eq("user_id", auth.user.id)
      .is("deactivated_at", null)
      .maybeSingle();
    if (!staff?.store_id) throw Object.assign(new Error("Staff access required"), { status: 403 });
    return { sb, storeId: staff.store_id, actor: auth.user.email || auth.user.id, userId: auth.user.id };
  }
}

function specificsFromIdentity(identity) {
  const brand = String(identity.brand || "").trim();
  const title = String(identity.title || "").trim();
  const rawModel = String(identity.model || "").trim();
  return (
    usableModelNumber(rawModel) ||
    itemSpecificsFromLookup({ model: rawModel, title, brand }) ||
    variantFromTitle(title, brand) ||
    String(identity.variant || '').trim() ||
    rawModel ||
    ""
  );
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
  return spent >= cap ? json(402, { ok: false, error: 'budget_exhausted',
    message: `AI scan budget reached ($${spent.toFixed(2)} / $${cap.toFixed(2)}). Raise the cap under More → AI scan budget, or fill fields by hand.` }) : null;
}

function photoFill(identity, brand, model, title) {
  return { brand, model, title, category: identity.category || '', description: identity.description || '',
    aspects: { ...(identity.variant ? { Variant: identity.variant } : {}),
      ...(identity.size ? { Size: identity.size } : {}),
      ...(identity.color ? { Color: identity.color } : {}), ...(brand ? { Brand: brand } : {}) } };
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

  const ctx = await authFromEvent(event);
  const body = JSON.parse(event.body || "{}");
  if (body.action === 'confirm') {
    const gtin = normalizeGtin(String(body.upc || '').trim());
    if (!gtin.ok) return json(400, { ok: false, error: 'valid_upc_required' });
    const fields = body.fields || {};
    const brand = String(fields.brand || '').trim().slice(0, 120);
    const title = String(fields.title || '').trim().slice(0, 250);
    if (!brand || !title) return json(400, { ok: false, error: 'product_details_required' });
    const cleanMeasure = value => { const n = Number(value); return Number.isFinite(n) && n > 0 && n < 10000 ? n : null; };
    const { data: existing } = await ctx.sb.from('floor_products').select('*').eq('gtin14', gtin.gtin14).maybeSingle();
    const productDimensions = Object.fromEntries(
      ['product_height_in', 'product_width_in', 'product_depth_in', 'product_weight_lb']
        .map(key => [key, cleanMeasure(fields[key])]).filter(([, value]) => value != null),
    );
    const aspects = { ...(existing?.aspects || {}), ...(fields.aspects && typeof fields.aspects === 'object' ? fields.aspects : {}) };
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
    }, { source: 'photo', actorId: ctx.userId,
      dimSources: { ...(existing?.dim_sources || {}),
        ...Object.fromEntries(['length_in','width_in','height_in','weight_lb'].filter(k => cleanMeasure(fields[k])).map(k => [k, 'measured_by_staff'])) } });
    const skus = Array.isArray(body.skus) ? body.skus.map(String).filter(Boolean).slice(0, 100) : [];
    if (skus.length && Object.keys(productDimensions).length) {
      const { error } = await ctx.sb.from('units').update({ ...productDimensions, dims_source: 'measured' })
        .eq('store_id', ctx.storeId).eq('upc', String(body.upc || '').trim()).in('sku', skus);
      if (error) await floorLog({ level: 'warn', event: 'receive_photo.measure_save_failed', message: error.message, storeId: ctx.storeId });
    }
    return saved ? json(200, { ok: true, gtin14: gtin.gtin14 }) : json(500, { ok: false, error: 'product_save_failed', message: 'The unit was saved, but its UPC product details could not be cached.' });
  }
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || /\*{3,}/.test(apiKey)) {
    await floorLog({ level: 'error', event: 'receive_photo.key_unavailable', message: 'Production GEMINI_API_KEY is empty or masked', storeId: ctx.storeId });
    return json(503, { ok: false, error: 'photo_identification_unavailable', message: 'Photo identification is temporarily unavailable. Retry or fill the fields by hand.' });
  }
  if (body.action === 'prices') {
    const denied = await budgetError(ctx);
    if (denied) return denied;
    const source = body.identity || {};
    const identity = Object.fromEntries(['title', 'brand', 'model', 'variant', 'size', 'color']
      .map(key => [key, String(source[key] || '').slice(0, 200)]));
    if (!identity.title || !identity.brand) return json(400, { ok: false, error: 'product_identity_required' });
    const started = Date.now();
    try {
      identity.unit_count = Math.max(1, Number(source.unit_count) || 1);
      const retail = await lookupRetail(ctx.sb, { store_id: ctx.storeId }, identity, { singlePass: true, exactMatch: true });
      const reference = medianReference(retail.prices || [], identity);
      const costUsd = tokenCost(retail.input || 0, retail.output || 0);
      await logUsage(ctx, identity, { price_input_tokens: retail.input || 0, price_output_tokens: retail.output || 0,
        search_queries: retail.queries || 0 }, costUsd);
      return json(200, { ok: true, price: reference,
        timing: { price_ms: Date.now() - started }, cost_usd: costUsd });
    } catch (e) {
      await floorLog({ level: 'warn', event: 'receive_photo.retail_fail', message: String(e?.message || e).slice(0, 300), storeId: ctx.storeId });
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
    identified = await identifyFrames([bytes]);
  } catch (e) {
    const upstream = String(e?.message || e).slice(0, 400);
    await floorLog({ level: 'error', event: 'receive_photo.identify_failed', message: upstream, storeId: ctx.storeId,
      detail: { elapsed_ms: Date.now() - t0, gemini_model: process.env.GEMINI_VIDEO_MODEL || 'gemini-3.8-flash' } });
    const status = /Gemini 401|Gemini 403|API key|PERMISSION_DENIED/i.test(upstream) ? 502 : /Gemini 429|RESOURCE_EXHAUSTED/i.test(upstream) ? 429 : 502;
    const message = status === 429 ? 'Photo identification is busy at the AI provider. Retry once or fill the fields by hand.'
      : /Gemini 404|model.*not found/i.test(upstream) ? 'The photo model is unavailable. Retry later or fill the fields by hand.'
      : /Gemini 401|Gemini 403|API key|PERMISSION_DENIED/i.test(upstream) ? 'The AI provider rejected the configured key. Retry later or fill the fields by hand.'
      : `Photo identification failed: ${upstream.replace(/Gemini \d+:\s*/, '').slice(0, 160)}. Retry or fill the fields by hand.`;
    return json(status, { ok: false, error: 'photo_identification_failed', message, upstream_error: upstream });
  }
  const identity = identified.result || {};
  const brand = String(identity.brand || "").trim();
  const model = specificsFromIdentity(identity);
  const rawTitle = String(identity.title || '').trim();
  const title = rawTitle ? (rawTitle.toLowerCase().startsWith(brand.toLowerCase()) ? rawTitle : `${brand} ${rawTitle}`.trim()) : listingTitle(brand, model);
  const identifyMs = Date.now() - t0;

  if (body.action === 'identify_only') {
    const costUsd = tokenCost(identified.input || 0, identified.output || 0);
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
      identity: { ...identity, brand, model, title },
      fill: photoFill(identity, brand, model, title), timing: { identify_ms: identifyMs }, cost_usd: costUsd });
  }

  // Price lookup in parallel spirit: start after name is known; user can see name first client-side
  // when we stream — for now one response with both.
  const job = { store_id: ctx.storeId };
  let prices = [];
  let retailMeta = { input: 0, output: 0, queries: 0, reused: false };
  try {
    retailMeta = await lookupRetail(ctx.sb, job, { ...identity, title, brand, model }, { singlePass: true, exactMatch: true });
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

  const costUsd = tokenCost(
    (identified.input || 0) + (retailMeta.input || 0),
    (identified.output || 0) + (retailMeta.output || 0),
  );
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
      variant: identity.variant || '',
      size: identity.size || '',
      category: identity.category || '',
      description: identity.description || '',
      color: identity.color || "",
      confidence: identity.confidence ?? null,
      unit_count: identity.unit_count || 1,
      catalog_title: identity.title || "",
    },
    fill: photoFill(identity, brand, model, title),
    price: reference,
    timing: { identify_ms: identifyMs, total_ms: Date.now() - t0 },
    cost_usd: costUsd,
  });
}

export default asNetlifyFunction(invoke);
