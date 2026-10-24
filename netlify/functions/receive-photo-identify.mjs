/**
 * Receive barcode-miss fallback: one product photo → Gemini identify + asking-price median.
 * POST { upc?, image_base64, mime_type? }
 * Does not set a selling price — returns median/range for the user to choose.
 */
import { asNetlifyFunction, floorLog } from "../lib/floor-log.mjs";
import { json, optionsOk, serviceClient } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { identifyFrames, lookupRetail, retailFields, tokenCost } from "../lib/video-scan.mjs";
import { itemSpecificsFromLookup, usableModelNumber, variantFromTitle } from "../lib/amazon.mjs";
import { normalizeGtin } from "../lib/gtin-normalize.mjs";
import {
  attachPhotoIdentityToMiss,
  listingTitle,
  saveFloorProduct,
} from "../lib/floor-products.mjs";
import sharp from "sharp";

async function authFromEvent(event) {
  try {
    return await portalAdminFromEvent(event);
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

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function specificsFromIdentity(identity) {
  const brand = String(identity.brand || "").trim();
  const title = String(identity.title || "").trim();
  const rawModel = String(identity.model || "").trim();
  return (
    usableModelNumber(rawModel) ||
    itemSpecificsFromLookup({ model: rawModel, title, brand }) ||
    variantFromTitle(title, brand) ||
    rawModel ||
    ""
  );
}

export async function invoke(event) {
  if (event.httpMethod === "OPTIONS") return optionsOk();
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST required" });

  const ctx = await authFromEvent(event);
  const body = JSON.parse(event.body || "{}");
  const rawB64 = String(body.image_base64 || "").replace(/^data:[^;]+;base64,/, "");
  if (!rawB64 || rawB64.length < 100) return json(400, { ok: false, error: "image_required" });

  let bytes;
  try {
    const raw = Buffer.from(rawB64, "base64");
    bytes = await sharp(raw)
      .rotate()
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return json(400, { ok: false, error: "invalid_image" });
  }

  const upc = String(body.upc || "").trim();
  const gtin = upc ? normalizeGtin(upc) : { ok: false };
  const t0 = Date.now();

  // Budget gate (same monthly cap as Video Scan). Query directly — RPC needs auth.uid().
  {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const settings = await ctx.sb
      .from("video_scan_settings")
      .select("monthly_cap_usd")
      .eq("store_id", ctx.storeId)
      .maybeSingle();
    const cap = Number(settings.data?.monthly_cap_usd ?? 30);
    const spend = await ctx.sb
      .from("video_scan_jobs")
      .select("estimated_cost_usd, reserved_usd")
      .eq("store_id", ctx.storeId)
      .gte("created_at", monthStart.toISOString());
    const spent = (spend.data || []).reduce(
      (n, row) => n + Number(row.estimated_cost_usd || 0) + Number(row.reserved_usd || 0),
      0,
    );
    if (spent >= cap) {
      return json(402, {
        ok: false,
        error: "budget_exhausted",
        message: `AI scan budget reached ($${spent.toFixed(2)} / $${cap.toFixed(2)}). Raise the cap under More → AI scan budget, or fill fields by hand.`,
      });
    }
  }

  const identified = await identifyFrames([bytes]);
  const identity = identified.result || {};
  const brand = String(identity.brand || "").trim();
  const model = specificsFromIdentity(identity);
  const title = listingTitle(brand, model) || String(identity.title || "").trim();
  const identifyMs = Date.now() - t0;

  // Price lookup in parallel spirit: start after name is known; user can see name first client-side
  // when we stream — for now one response with both.
  const job = { store_id: ctx.storeId };
  let prices = [];
  let retailMeta = { input: 0, output: 0, queries: 0, reused: false };
  try {
    retailMeta = await lookupRetail(ctx.sb, job, { ...identity, title, brand, model });
    prices = retailMeta.prices || [];
  } catch (e) {
    await floorLog({
      level: "warn",
      event: "receive_photo.retail_fail",
      message: String(e?.message || e).slice(0, 200),
      storeId: ctx.storeId,
    });
  }

  const fields = retailFields(prices, { ...identity, title, brand, model, unit_count: identity.unit_count });
  const unitCents = (fields.retail_prices || [])
    .filter((p) => !p.approximate && !p.size_mismatch)
    .map((p) => {
      const pack = Math.max(1, Number(p.pack_size) || 1);
      const units = Math.max(1, Number(identity.unit_count) || 1);
      return Math.round(p.price_cents / Math.max(1, pack / units));
    });
  const askMedian = median(unitCents);
  const askLow = unitCents.length ? Math.min(...unitCents) : null;
  const askHigh = unitCents.length ? Math.max(...unitCents) : null;
  const highest = (fields.retail_prices || [])[0] || null;

  const costUsd = tokenCost(
    (identified.input || 0) + (retailMeta.input || 0),
    (identified.output || 0) + (retailMeta.output || 0),
  );
  // Record spend against video_scan_jobs so the existing AI scan budget UI counts this.
  try {
    await ctx.sb.from("video_scan_jobs").insert({
      store_id: ctx.storeId,
      created_by: ctx.userId,
      status: "discarded",
      video_path: `receive-photo/${ctx.storeId}/${Date.now()}.jpg`,
      still_paths: [],
      result: { identity: { ...identity, title, brand, model, receive_photo: true } },
      estimated_cost_usd: costUsd,
      reserved_usd: 0,
      search_queries: retailMeta.queries || 0,
      error: null,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.log("receive_photo_spend_log_failed", String(e?.message || e));
  }

  if (gtin.ok) {
    await attachPhotoIdentityToMiss(ctx.sb, {
      gtin14: gtin.gtin14,
      identity: { brand, model, title, confidence: identity.confidence, upc },
      missId: body.miss_id || null,
    });
    await saveFloorProduct(
      ctx.sb,
      { gtin14: gtin.gtin14, upcA: gtin.upcA, ean13: gtin.ean13 },
      {
        brand,
        model,
        title,
        description: null,
        features: [],
        aspects: identity.color ? { Color: identity.color } : {},
        package: {},
        images: [],
        category: null,
        asin: null,
      },
      { source: "photo", actorId: ctx.userId },
    );
  }

  await floorLog({
    level: "info",
    event: "receive_photo.ok",
    message: title || brand || "identified",
    storeId: ctx.storeId,
    detail: { upc, identify_ms: identifyMs, total_ms: Date.now() - t0, prices: unitCents.length, cost_usd: costUsd },
  });

  return json(200, {
    ok: true,
    identity: {
      brand,
      model,
      title,
      color: identity.color || "",
      confidence: identity.confidence ?? null,
      unit_count: identity.unit_count || 1,
      catalog_title: identity.title || "",
    },
    fill: {
      brand,
      model,
      title,
      ask_cents_suggestion: askMedian,
    },
    price: {
      kind: "asking",
      median_cents: askMedian,
      low_cents: askLow,
      high_cents: askHigh,
      count: unitCents.length,
      highest_retail: highest
        ? { store: highest.store, price_cents: highest.price_cents, url: highest.url, product_name: highest.product_name }
        : null,
      listings: (fields.retail_prices || []).slice(0, 8),
    },
    timing: { identify_ms: identifyMs, total_ms: Date.now() - t0 },
    cost_usd: costUsd,
  });
}

export default asNetlifyFunction(invoke);
