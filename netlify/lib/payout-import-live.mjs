// Real eBay / Square calls behind payout-import.mjs. Loaded lazily by the eBay sync; the pure parts stay dependency-free.
import { importPayouts } from "./payout-import.mjs";

const STATE_KEY = "payout_import_state";

async function fetchEbayPayouts(storeId, sinceIso) {
  const { ebayFetch, resolveEbayAccount } = await import("./ebay.mjs");
  const account = await resolveEbayAccount(storeId, { role: "selling" });
  const filter = encodeURIComponent(`payoutDate:[${sinceIso}..${new Date().toISOString()}]`);
  const payouts = [];
  for (let offset = 0; offset < 2000; offset += 200) {
    const page = await ebayFetch(storeId, "GET", `/sell/finances/v1/payout?filter=${filter}&limit=200&offset=${offset}`, undefined, { _account: account });
    const got = page?.payouts || [];
    payouts.push(...got);
    if (got.length < 200) break;
  }
  return { payouts };
}

async function fetchSquarePayouts(storeId, sinceIso) {
  const { getStoreSquareAccess } = await import("./square.mjs");
  const { accessToken, locationId } = await getStoreSquareAccess(storeId);
  if (!accessToken || !locationId) throw new Error("square_not_connected");
  const host = (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase() === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  const payouts = [];
  let cursor = "";
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${host}/v2/payouts?location_id=${encodeURIComponent(locationId)}&begin_time=${encodeURIComponent(sinceIso)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { headers: { Authorization: `Bearer ${accessToken}`, "Square-Version": "2024-10-17" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.errors?.[0]?.code || `square_payouts_${res.status}`);
    payouts.push(...(body.payouts || []));
    cursor = body.cursor || "";
    if (!cursor) break;
  }
  return { payouts };
}

/** At most once every 6 hours per store; failures are recorded in store_settings, never thrown. */
export async function runPayoutImport(sb, storeId) {
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  return importPayouts({
    loadState: async () => must(await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", STATE_KEY).maybeSingle())?.value || {},
    saveState: async (value) => { must(await sb.from("store_settings").upsert({ store_id: storeId, key: STATE_KEY, value }, { onConflict: "store_id,key" })); },
    fetchEbay: (since) => fetchEbayPayouts(storeId, since),
    fetchSquare: (since) => fetchSquarePayouts(storeId, since),
    importRows: async (platform, rows) => must(await sb.rpc("floor_import_platform_payouts", { p_store: storeId, p_platform: platform, p_rows: rows })),
  });
}
