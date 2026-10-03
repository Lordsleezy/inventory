import { sendResend } from "./receipt.mjs";
import { ownerEmails } from "./web-order-email.mjs";

export const SITE_URL = (process.env.STORE_SITE_URL || "https://openboxindustries.com").replace(/\/$/, "");
// Mirrors the website's isPublicMerchandise() so a hidden test record gets a precise reason.
const looksLikeTest = (item) => /^test(?:[-_\s]|$)/i.test(item.sku) || ["19999", "11156"].includes(item.sku)
  || /(?:\btest\b.*\bdo not buy\b|\bdo not buy\b|\bnot for sale\b|\bsample listing\b)/i.test(item.title || "");

export function feedSkus(csv) {
  return String(csv).split(/\r?\n/).slice(1).map(line => line.match(/^"((?:[^"]|"")*)"/)?.[1]?.replace(/""/g, '"')).filter(Boolean);
}

async function getText(url, fetchImpl) {
  const res = await fetchImpl(`${url}${url.includes("?") ? "&" : "?"}check=${Date.now()}`, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

async function snapshot(sb, storeId, fetchImpl) {
  const { data: floor, error } = await sb.rpc("listing_check_floor", { p_store: storeId });
  if (error) throw error;
  const viewSkus = [];
  for (let offset = 0;; offset += 1000) {
    const { data, error: viewError } = await sb.from("storefront_items").select("sku").eq("store_id", storeId).order("sku").range(offset, offset + 999);
    if (viewError) throw viewError;
    viewSkus.push(...data.map(r => r.sku));
    if (data.length < 1000) break;
  }
  const catalog = JSON.parse(await getText(`${SITE_URL}/api/catalog`, fetchImpl));
  if (catalog.status === "unavailable") throw new Error("Website catalog reports unavailable");
  const siteSkus = (catalog.items || []).map(i => i.sku);
  const feed = feedSkus(await getText(`${SITE_URL}/catalog-feed.csv`, fetchImpl));
  return { floor, view: new Set(viewSkus), site: new Set(siteSkus), feed: new Set(feed) };
}

export function compare({ floor, view, site, feed }) {
  const problems = [];
  const listable = new Set(floor.map(f => f.sku));
  for (const f of floor) {
    if (!view.has(f.sku)) problems.push({ sku: f.sku, title: f.title, where: "floor_view", reason: f.reason || "Not in the storefront view (cause not identified)" });
    else if (!site.has(f.sku)) problems.push({ sku: f.sku, title: f.title, where: "website", reason: looksLikeTest(f) ? "Website hides it because the title/SKU looks like a test record" : "In Floor's storefront but missing on openboxindustries.com" });
    if (view.has(f.sku) && !feed.has(f.sku)) problems.push({ sku: f.sku, title: f.title, where: "feed", reason: "Missing from /catalog-feed.csv" });
  }
  for (const [where, set] of [["floor_view", view], ["website", site], ["feed", feed]]) {
    for (const sku of set) if (!listable.has(sku)) problems.push({ sku, title: null, where, reason: `Shown in ${where === "floor_view" ? "the storefront view" : where === "website" ? "the website" : "the catalog feed"} but not listable in Floor (sold, unpriced, or no photo)` });
  }
  return {
    counts: { floor_listable: listable.size, storefront_view: view.size, website: site.size, catalog_feed: feed.size },
    problems,
  };
}

/** Floor listable units vs storefront view vs live site vs catalog feed; self-heal; email leftovers. */
export async function runListingCheck(sb, storeId, { fetchImpl = fetch, email = true, healDelayMs = 20000 } = {}) {
  const healed = [];
  let result;
  try {
    let snap = await snapshot(sb, storeId, fetchImpl);
    result = compare(snap);
    if (result.problems.length) {
      // Self-heal 1: expired holds that left units stuck in "reserved".
      if (snap.floor.some(f => f.state === "reserved")) {
        const { data } = await sb.rpc("release_expired_reservations");
        healed.push({ action: "released_expired_reservations", count: data ?? null });
      }
      // Self-heal 2: give any stale cache/CDN copy time to expire, then re-read with cache-busters.
      await new Promise(r => setTimeout(r, healDelayMs));
      healed.push({ action: "refetched_without_cache" });
      snap = await snapshot(sb, storeId, fetchImpl);
      const before = new Set(result.problems.map(p => `${p.sku}|${p.where}`));
      result = compare(snap);
      const after = new Set(result.problems.map(p => `${p.sku}|${p.where}`));
      const fixed = [...before].filter(k => !after.has(k));
      if (fixed.length) healed.push({ action: "resolved", items: fixed });
    }
  } catch (err) {
    result = { counts: {}, problems: [{ sku: null, where: "check", reason: `Check could not run: ${err.message}` }], error: err.message };
  }
  const ok = result.problems.length === 0;
  let emailedAt = null;
  if (!ok && email) {
    const to = await ownerEmails(sb, storeId);
    const text = ["The daily website listing check found problems it could not fix automatically.", "",
      `Floor listable: ${result.counts.floor_listable ?? "?"} · Storefront view: ${result.counts.storefront_view ?? "?"} · Website: ${result.counts.website ?? "?"} · Catalog feed: ${result.counts.catalog_feed ?? "?"}`, "",
      ...result.problems.map(p => `SKU ${p.sku ?? "—"}${p.title ? ` (${p.title})` : ""}: ${p.reason}`), "",
      "Floor Admin → Online selling shows the latest check.", "", "Open Box Industries"].join("\n");
    let sent = 0;
    for (const addr of to) {
      const r = await sendResend({ to: addr, subject: `Website listing check: ${result.problems.length} problem(s)`, text }).catch(() => ({}));
      if (r.ok) sent++;
    }
    if (sent) emailedAt = new Date().toISOString();
  }
  const { data: row, error } = await sb.from("listing_checks").insert({
    store_id: storeId, ok, counts: result.counts, problems: result.problems, healed, emailed_at: emailedAt, error: result.error || null,
  }).select("*").single();
  if (error) throw error;
  return row;
}
