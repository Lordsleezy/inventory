import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { withLock, dbBusy } from "../lib/bg-guard.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { sendInternalAlert, gmailConfigured, filterDeliverableEmails } from "../lib/mail.mjs";
import { marketplaceOrderKey } from "../lib/marketplace-email-parse.mjs";

/**
 * Safety net: sale emails in marketplace_email_sales older than 10 minutes
 * that never produced a web_orders row → Gmail SMTP alert + Jobs log line.
 * Also backfills unmatched Orders rows when missing (same as migration logic).
 *
 * Schedule: every 5 minutes (netlify.toml).
 */

const STALE_MINUTES = 10;
const LOOKBACK_HOURS = 48;

function isSaleSubject(subject) {
  const s = String(subject || "");
  if (/removed your listing|still need to ship|magic link|sign up|log in/i.test(s)) return false;
  return /sale confirmation|you(?:'ve| have) made a sale|sold|shipping label and sale/i.test(s);
}

async function notifyEmails(sb) {
  const cfg =
    (await sb.from("store_settings").select("value").eq("key", "order_notify_emails").limit(1)).data?.[0]
      ?.value || ["pgg124@gmail.com", "obitracking@gmail.com"];
  const to = filterDeliverableEmails(Array.isArray(cfg) ? cfg : []);
  if (!to.length) return filterDeliverableEmails(["pgg124@gmail.com", "obitracking@gmail.com"]);
  return to;
}

async function ensureOrderFromSale(sb, row) {
  const channel = String(row.marketplace || "").toLowerCase();
  if (!channel) return null;
  const orderKey = marketplaceOrderKey({ orderNumber: row.order_number, messageId: row.message_id || row.id });
  const paymentId = `marketplace:${channel}:${orderKey}`;
  const { data: existing } = await sb
    .from("web_orders")
    .select("id")
    .eq("store_id", row.store_id)
    .eq("payment_id", paymentId)
    .maybeSingle();
  if (existing) return { id: existing.id, created: false };

  const cents = Number(row.sale_price_cents) > 0 ? Math.round(Number(row.sale_price_cents)) : 0;
  const paidIso = row.created_at || new Date().toISOString();
  const orderNo = `${channel.toUpperCase()}-${String(orderKey).replace(/[^A-Za-z0-9-]/g, "").slice(0, 28)}`.slice(0, 40);
  const buyer = row.buyer && typeof row.buyer === "object" ? row.buyer : {};
  const { data, error } = await sb
    .from("web_orders")
    .insert({
      store_id: row.store_id,
      sku: "UNMATCHED",
      sale_id: null,
      status: "paid",
      channel,
      fulfillment: row.fulfillment === "pickup" ? "pickup" : "ship",
      order_no: orderNo,
      paid_at: paidIso,
      buyer_name: buyer.name || null,
      buyer_email: buyer.email || null,
      buyer_phone: buyer.phone || null,
      ship_line1: buyer.line1 || null,
      ship_line2: buyer.line2 || null,
      ship_city: buyer.city || null,
      ship_region: buyer.region || null,
      ship_postal: buyer.postal || null,
      ship_country: buyer.country || "US",
      item_cents: cents,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: cents,
      payment_id: paymentId,
      payment_env: "production",
      ship_by: row.ship_by || null,
      match_status: "unmatched",
      marketplace_title: String(row.item_title || row.subject || `${channel} sale`).slice(0, 250),
      created_at: paidIso,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    if (/duplicate|23505/i.test(error.message)) return { id: null, created: false };
    throw error;
  }
  await sb.from("channel_orders").upsert(
    {
      store_id: row.store_id,
      provider: channel,
      order_id: orderKey,
      sku: "UNMATCHED",
      sale_id: null,
      item_cents: cents,
    },
    { onConflict: "store_id,provider,order_id" },
  );
  return { id: data?.id || null, created: true };
}

async function runWatch(sb) {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();
  const staleBefore = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
  const { data: rows, error } = await sb
    .from("marketplace_email_sales")
    .select(
      "id,store_id,marketplace,subject,item_title,sale_price_cents,order_number,message_id,buyer,fulfillment,ship_by,state,sale_id,created_at",
    )
    .in("marketplace", ["depop", "mercari"])
    .gte("created_at", since)
    .in("state", ["needs_review", "matched"])
    .order("created_at", { ascending: false })
    .limit(80);
  if (error) throw error;

  const candidates = (rows || []).filter((r) => {
    if (!isSaleSubject(r.subject) && r.sale_price_cents == null) return false;
    if (/removed your listing|still need to ship|magic link|sign up|^log in/i.test(String(r.subject || ""))) {
      return false;
    }
    // Price-only rows still need a sale-ish subject, except already-matched ingest.
    if (r.state === "matched" && r.sale_id) return true;
    return isSaleSubject(r.subject) || (r.sale_price_cents != null && /sold|sale/i.test(String(r.subject || "")));
  });

  let created = 0;
  let already = 0;
  const missing = [];

  for (const row of candidates) {
    // Matched rows already have sale_id — still require a web_orders row.
    const order = await ensureOrderFromSale(sb, row);
    if (order?.created) created += 1;
    else if (order?.id) already += 1;

    const channel = String(row.marketplace || "").toLowerCase();
    const orderKey = marketplaceOrderKey({ orderNumber: row.order_number, messageId: row.message_id || row.id });
    const paymentId = `marketplace:${channel}:${orderKey}`;
    const { data: wo } = await sb
      .from("web_orders")
      .select("id")
      .eq("store_id", row.store_id)
      .eq("payment_id", paymentId)
      .maybeSingle();
    if (!wo && row.created_at && row.created_at < staleBefore) {
      missing.push(row);
    }
  }

  let alerted = 0;
  if (missing.length && gmailConfigured()) {
    const to = await notifyEmails(sb);
    const lines = missing.slice(0, 15).map(
      (r) =>
        `- ${r.marketplace} · ${r.subject || r.item_title || "sale"} · $${((r.sale_price_cents || 0) / 100).toFixed(2)} · email_sale_id=${r.id} · age>${STALE_MINUTES}m`,
    );
    const sent = await sendInternalAlert({
      to,
      subject: `Floor alert: ${missing.length} marketplace sale email(s) without Orders row`,
      text: [
        `Sale emails older than ${STALE_MINUTES} minutes with no matching Orders (web_orders) row.`,
        `Watch backfilled ${created} order(s) this run; ${missing.length} still missing after check.`,
        "",
        ...lines,
        "",
        "Open Admin → Orders (Needs SKU match) and Logs → Jobs (marketplace-sale-watch).",
      ].join("\n"),
    });
    if (!sent.skipped) alerted = 1;
  }

  return {
    checked: candidates.length,
    orders_created: created,
    orders_present: already,
    stale_missing: missing.length,
    alerted,
    schedule: true,
  };
}

async function handle(event) {
  if (event?.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  const sb = serviceClient();
  try {
    const result = await withLock("marketplace-sale-watch", 240, async () => {
      if (await dbBusy(sb)) return { skipped: "database_busy" };
      return runWatch(sb);
    });
    return json(200, { ...result, schedule: isNetlifyScheduleEvent(event) });
  } catch (e) {
    return json(500, { error: String(e?.message || e).slice(0, 300) });
  }
}

export const invoke = wrapHandler("marketplace-sale-watch", handle);

export default asNetlifyFunction(invoke);
