import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { wrapHandler, floorLog, asNetlifyFunction } from "../lib/floor-log.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { sendInternalAlert, gmailConfigured, filterDeliverableEmails } from "../lib/mail.mjs";
import { reconcileAlertText, reconcileFindings } from "../lib/inventory-reconcile.mjs";
import { withdrawSku } from "../lib/ebay.mjs";

/**
 * Every 15 minutes: catch a sale that left a unit Available, and sold units
 * whose marketplace row is still "listed". Emails the owner. Ends eBay
 * listings for sold units. Opens a delist reminder for channels we cannot
 * end through an API (Depop, Whatnot).
 */

const PAGE = 1000;

async function notifyEmails(sb) {
  const cfg =
    (await sb.from("store_settings").select("value").eq("key", "order_notify_emails").limit(1)).data?.[0]?.value || [
      "pgg124@gmail.com",
      "obitracking@gmail.com",
    ];
  const to = filterDeliverableEmails(Array.isArray(cfg) ? cfg : []);
  if (!to.length) return filterDeliverableEmails(["pgg124@gmail.com", "obitracking@gmail.com"]);
  return to;
}

async function loadAll(sb, table, columns, filters = []) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let query = sb.from(table).select(columns).range(from, from + PAGE - 1);
    for (const filter of filters) query = filter(query);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function openDelist(sb, storeId, row) {
  const { data: existing } = await sb
    .from("delist_tasks")
    .select("id")
    .eq("store_id", storeId)
    .eq("sku", row.sku)
    .eq("channel", row.channel)
    .is("completed_at", null)
    .limit(1);
  if (existing?.length) return false;
  const { error } = await sb.from("delist_tasks").insert({
    store_id: storeId,
    sku: row.sku,
    channel: row.channel,
    nag_after: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return true;
}

async function run(sb) {
  const [units, sales, orders, listings] = await Promise.all([
    loadAll(sb, "units", "store_id,sku,title,state"),
    loadAll(sb, "sales", "store_id,sku,channel,price_cents,sold_at,voided_at", [(q) => q.is("voided_at", null)]),
    loadAll(sb, "web_orders", "store_id,sku,channel,status,item_cents,paid_at"),
    loadAll(sb, "listings", "store_id,sku,channel,status,listing_id", [(q) => q.eq("status", "listed")]),
  ]);
  const findings = reconcileFindings({ units, sales, orders, listings });
  const stores = new Set([
    ...findings.soldButAvailable.map((row) => units.find((unit) => unit.sku === row.sku)?.store_id),
    ...findings.soldStillListed.map((row) => units.find((unit) => unit.sku === row.sku)?.store_id),
  ].filter(Boolean));

  const ended = [];
  const reminded = [];
  const errors = [];
  for (const row of findings.soldStillListed) {
    const storeId = units.find((unit) => unit.sku === row.sku)?.store_id;
    if (!storeId) continue;
    if (row.channel === "ebay") {
      try {
        await withdrawSku(storeId, row.sku);
        ended.push(row.sku);
      } catch (err) {
        errors.push(`${row.sku} ebay: ${err instanceof Error ? err.message : String(err)}`);
        try {
          if (await openDelist(sb, storeId, row)) reminded.push(`${row.sku}:${row.channel}`);
        } catch (taskErr) {
          errors.push(`${row.sku} delist: ${taskErr instanceof Error ? taskErr.message : String(taskErr)}`);
        }
      }
      continue;
    }
    try {
      if (await openDelist(sb, storeId, row)) reminded.push(`${row.sku}:${row.channel}`);
    } catch (err) {
      errors.push(`${row.sku} ${row.channel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let mailed = false;
  if (findings.soldButAvailable.length || findings.soldStillListed.length) {
    const to = await notifyEmails(sb);
    if (gmailConfigured() && to.length) {
      await sendInternalAlert({
        to,
        subject: `Floor: ${findings.soldButAvailable.length} sold-but-available, ${findings.soldStillListed.length} sold-but-listed`,
        text: reconcileAlertText(findings),
      });
      mailed = true;
    }
  }

  return {
    ok: errors.length === 0,
    stores: stores.size,
    sold_but_available: findings.soldButAvailable,
    sold_still_listed: findings.soldStillListed,
    ebay_ended: ended,
    delist_reminders: reminded,
    mailed,
    errors,
  };
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (!isNetlifyScheduleEvent(event)) {
    const secret = process.env.MARKETPLACE_EMAIL_SECRET;
    const got = event.headers?.["x-marketplace-secret"] || event.headers?.["X-Marketplace-Secret"];
    if (!secret || got !== secret) return json(401, { error: "unauthorized" });
  }
  try {
    const sb = serviceClient();
    const result = await withLock("inventory-reconcile", 240, () => run(sb), sb);
    await floorLog({
      level: result.errors?.length ? "warn" : "info",
      event: "inventory.reconcile",
      message: `available=${result.sold_but_available?.length || 0} still_listed=${result.sold_still_listed?.length || 0} ended=${result.ebay_ended?.length || 0} reminded=${result.delist_reminders?.length || 0}`,
      detail: result,
    });
    return json(200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: message.slice(0, 300) });
  }
}

export const invoke = wrapHandler("inventory-reconcile", handle);
export default asNetlifyFunction(invoke);
