#!/usr/bin/env node
/**
 * READ-ONLY. Re-pulls real amounts from eBay (Finances API), Amazon (SP-API financial events)
 * and TikTok Shop (order statement transactions) for existing sales and prints a per-sale diff
 * against what Floor's sale_ledger has. It never writes to the database or the platforms, so it
 * cannot change any payout. Sales sold on/before the latest payout payment are marked PAID-OUT
 * and listed separately for the owner to decide on.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… (+ the same eBay/Amazon/TikTok env vars Netlify uses)
 *   node scripts/platform-fee-repull.mjs --store <uuid> [--since 2026-01-01] [--channels ebay,amazon,tiktok] [--out diff.csv]
 */
import { writeFileSync } from "node:fs";
import { serviceClient } from "../netlify/lib/server.mjs";
import { ebayFetch } from "../netlify/lib/ebay.mjs";
import { spapiFetch } from "../netlify/lib/amazon.mjs";
import { tiktokApiFetch } from "../netlify/lib/tiktok-shop.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const storeId = args.store || process.env.FLOOR_STORE_ID;
const since = args.since || "2026-01-01";
const channels = String(args.channels || "ebay,amazon,tiktok").split(",").map((s) => s.trim());
if (!storeId) {
  console.error("usage: --store <uuid> required");
  process.exit(2);
}

const cents = (v) => (v == null || v === "" ? 0 : Math.round(Number(v?.value ?? v?.CurrencyAmount ?? v?.amount ?? v) * 100) || 0);
const abs = Math.abs;

async function ebayAmounts() {
  const byOrder = new Map();
  const get = (id) => byOrder.get(id) || byOrder.set(id, { fees: 0, net: null, ad: 0 }).get(id);
  for (const type of ["SALE", "NON_SALE_CHARGE"]) {
    let offset = 0;
    for (;;) {
      const filter = encodeURIComponent(`transactionType:{${type}},transactionDate:[${since}T00:00:00.000Z..]`);
      const res = await ebayFetch(storeId, "GET", `/sell/finances/v1/transaction?filter=${filter}&limit=200&offset=${offset}`);
      const txns = res?.transactions || [];
      for (const tx of txns) {
        const orderId = tx.orderId || (tx.references || []).find((r) => r.referenceType === "ORDER_ID")?.referenceId;
        if (!orderId) continue;
        const row = get(orderId);
        if (type === "SALE") {
          const lineFees = (tx.orderLineItems || []).flatMap((l) => l.marketplaceFees || []).reduce((n, f) => n + abs(cents(f.amount)), 0);
          row.fees += lineFees || abs(cents(tx.totalFeeAmount));
          row.net = (row.net || 0) + cents(tx.amount) * (tx.bookingEntry === "DEBIT" ? -1 : 1);
        } else {
          const amt = abs(cents(tx.amount));
          row.fees += amt;
          if (/AD_FEE/.test(tx.feeType || "")) row.ad += amt;
          if (row.net != null) row.net -= amt;
        }
      }
      if (txns.length < 200) break;
      offset += txns.length;
    }
  }
  return byOrder;
}

async function amazonOrderAmounts(orderId) {
  const res = await spapiFetch(storeId, "GET", `/finances/v0/orders/${encodeURIComponent(orderId)}/financialEvents`);
  const items = (res?.payload?.FinancialEvents?.ShipmentEventList || []).flatMap((e) => e.ShipmentItemList || []);
  let fees = 0, charges = 0, withheld = 0, promo = 0;
  for (const it of items) {
    fees += (it.ItemFeeList || []).reduce((n, f) => n + abs(cents(f.FeeAmount)), 0);
    charges += (it.ItemChargeList || []).reduce((n, c) => n + cents(c.ChargeAmount), 0);
    promo += (it.PromotionList || []).reduce((n, p) => n + cents(p.PromotionAmount), 0);
    withheld += (it.ItemTaxWithheldList || []).flatMap((w) => w.TaxesWithheld || []).reduce((n, c) => n + abs(cents(c.ChargeAmount)), 0);
  }
  if (!items.length) return null;
  return { fees, net: charges + promo - fees - withheld, tax: withheld };
}

function sumFeeFields(obj, out = { fees: 0, net: null }) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") sumFeeFields(v, out);
    else if (/(_fee|_commission)(_amount)?$/.test(k) && Number.isFinite(Number(v))) out.fees += abs(cents(v));
    else if (k === "settlement_amount" && Number.isFinite(Number(v))) out.net = (out.net || 0) + cents(v);
  }
  return out;
}

async function tiktokOrderAmounts(orderId) {
  const res = await tiktokApiFetch(storeId, "GET", `/finance/202309/orders/${encodeURIComponent(orderId)}/statement_transactions`);
  const data = res?.data || res;
  if (!data) return null;
  return sumFeeFields(data);
}

const sb = serviceClient();
const { data: ledger, error } = await sb
  .from("sale_ledger")
  .select("sale_id, sku, channel, sold_at, price_cents, channel_fee_cents, fee_source, ship_cost_cents, tax_collected_cents, profit_cents, voided_at")
  .eq("store_id", storeId)
  .in("channel", channels)
  .is("voided_at", null)
  .gte("sold_at", since)
  .order("sold_at");
if (error) throw new Error(error.message);
const saleIds = ledger.map((r) => r.sale_id);
const orders = new Map();
for (let i = 0; i < saleIds.length; i += 200) {
  const { data } = await sb.from("channel_orders").select("sale_id, order_id, payout_cents").in("sale_id", saleIds.slice(i, i + 200));
  for (const o of data || []) orders.set(o.sale_id, o);
}
const { data: lastPay } = await sb.from("portal_payout_payments").select("paid_at").eq("store_id", storeId)
  .order("paid_at", { ascending: false }).limit(1);
const paidThrough = lastPay?.[0]?.paid_at ? new Date(lastPay[0].paid_at) : null;

const ebay = channels.includes("ebay") ? await ebayAmounts().catch((e) => (console.error("eBay:", e.message), new Map())) : new Map();
const rows = [];
for (const s of ledger) {
  const o = orders.get(s.sale_id);
  let p = null, err = "";
  try {
    if (!o?.order_id) err = "no_order_id";
    else if (s.channel === "ebay") p = ebay.get(o.order_id) || null;
    else if (s.channel === "amazon") p = await amazonOrderAmounts(o.order_id);
    else if (s.channel === "tiktok") p = await tiktokOrderAmounts(o.order_id);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  if (!p && !err) err = "not_found_on_platform";
  const floorNet = o?.payout_cents ?? null;
  rows.push({
    channel: s.channel, sku: s.sku, sale_id: s.sale_id, order_id: o?.order_id || "", sold_at: s.sold_at,
    floor_fee: s.channel_fee_cents, floor_fee_source: s.fee_source, platform_fee: p?.fees ?? "",
    fee_diff: p ? p.fees - (s.channel_fee_cents || 0) : "",
    floor_net: floorNet ?? "", platform_net: p?.net ?? "",
    net_diff: p?.net != null && floorNet != null ? p.net - floorNet : "",
    paid_out: paidThrough && new Date(s.sold_at) <= paidThrough ? "PAID-OUT" : "",
    error: err,
  });
}

const cols = Object.keys(rows[0] || { channel: 1 });
const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))].join("\n");
if (args.out) writeFileSync(args.out, csv); else console.log(csv);
const changed = rows.filter((r) => r.fee_diff !== "" && r.fee_diff !== 0);
const paidChanged = changed.filter((r) => r.paid_out);
console.error(`\n${rows.length} sales checked, ${changed.length} with a fee difference, ${rows.filter((r) => r.error).length} could not be re-pulled.`);
console.error(`Paid-out sales with a difference (owner decides; nothing was changed): ${paidChanged.length}`);
for (const r of paidChanged) console.error(`  ${r.channel} SKU ${r.sku} order ${r.order_id}: Floor fee ${r.floor_fee} vs platform ${r.platform_fee} (diff ${r.fee_diff})`);
