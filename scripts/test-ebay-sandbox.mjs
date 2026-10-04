/**
 * Sandbox exercise for eBay drafts. Refuses to publish when EBAY_ENV is production.
 * Cleans up every SKU it creates.
 *
 *   netlify dev:exec -- node scripts/test-ebay-sandbox.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { syncDrafts, prepareDraft, saveDraft, saveBox, pushDrafts, endDraft } from "../netlify/lib/ebay-drafts.mjs";
import { ingestEbayOrder, withdrawOpenEbayTasks, withdrawSku } from "../netlify/lib/ebay.mjs";

const SKUS = ["99081", "99082", "99083", "99084", "99085"];
const env = process.env.EBAY_ENV || "sandbox";
if (env === "production") {
  console.log("SKIP publish: EBAY_ENV is production");
  process.exit(0);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function log(label, value) {
  console.log(label, typeof value === "string" ? value : JSON.stringify(value));
}

async function storeId() {
  const { data, error } = await sb.from("connections").select("store_id,status").eq("provider", "ebay").eq("status", "connected").limit(1);
  if (error) throw new Error(error.message);
  if (!data?.[0]) throw new Error("No connected eBay sandbox account");
  return data[0].store_id;
}

async function samplePhoto(store) {
  const { data, error } = await sb.from("photos").select("path").eq("store_id", store).limit(1);
  if (error) throw new Error(error.message);
  if (!data?.[0]?.path) throw new Error("No existing photo to reuse");
  return data[0].path;
}

async function makeUnit(store, sku, fields, photo) {
  const now = new Date().toISOString();
  const { data: occupied } = await sb.from("sku_ledger").select("sku").eq("store_id", store).eq("sku", sku).maybeSingle();
  if (occupied) throw new Error(`Refusing to overwrite existing SKU ${sku}`);
  const ledger = await sb.from("sku_ledger").insert({ sku, issued_at: now, store_id: store, label: "ebay sandbox test", is_test: true });
  if (ledger.error) throw new Error(ledger.error.message);
  const row = {
    sku, store_id: store, state: "available", ask_cents: 4000, received_at: now, updated_at: now,
    show_on_website: true, title: "Sandbox desk lamp", brand: "Test", model: "LAMP", category: "Lighting",
    condition: "Good", listing_body: "Sandbox listing used to prove the eBay draft flow. Not for sale.", is_test: true,
    ...fields,
  };
  const unit = await sb.from("units").insert(row);
  if (unit.error) throw new Error(unit.error.message);
  if (photo) {
    const pic = await sb.from("photos").insert({ store_id: store, sku, path: photo, is_primary: true });
    if (pic.error) throw new Error(pic.error.message);
  }
}

async function fillRequired(store, sku) {
  let draft = await prepareDraft(store, sku);
  for (let i = 0; i < 3 && !draft.ready; i++) {
    const missing = (draft.aspect_defs || []).filter((def) => def.required && !String(draft.aspects?.[def.name] || "").trim());
    if (!missing.length) break;
    const aspects = {};
    for (const def of missing) aspects[def.name] = def.allowed?.[0] || "See photos";
    draft = await saveDraft(store, sku, { aspects });
  }
  return draft;
}

async function cleanup(store) {
  const { data: ledger } = await sb.from("sku_ledger").select("sku,is_test").eq("store_id", store).in("sku", SKUS);
  const { data: units } = await sb.from("units").select("sku,is_test").eq("store_id", store).in("sku", SKUS);
  const marked = new Set((ledger || []).filter((row) => row.is_test).map((row) => row.sku));
  const safe = SKUS.filter((sku) => marked.has(sku) && (units || []).some((row) => row.sku === sku && row.is_test));
  for (const sku of safe) {
    await withdrawSku(store, sku).catch((err) => log("withdraw leftover", `${sku} ${err.message}`));
  }
  if (!safe.length) return;
  await sb.from("delist_tasks").delete().eq("store_id", store).in("sku", safe);
  await sb.from("channel_orders").delete().eq("store_id", store).in("sku", safe);
  await sb.from("web_orders").delete().eq("store_id", store).in("sku", safe);
  await sb.from("sales").delete().eq("store_id", store).in("sku", safe);
  await sb.from("listings").delete().eq("store_id", store).in("sku", safe);
  await sb.from("ebay_drafts").delete().eq("store_id", store).in("sku", safe);
  await sb.from("photos").delete().eq("store_id", store).in("sku", safe);
  await sb.from("events").delete().eq("store_id", store).in("sku", safe);
  await sb.from("incidents").delete().eq("store_id", store).in("sku", safe);
  await sb.from("units").delete().eq("store_id", store).in("sku", safe).eq("is_test", true);
  await sb.from("sku_ledger").delete().eq("store_id", store).in("sku", safe).eq("is_test", true);
}

const results = [];
let store;
try {
  store = await storeId();
  log("store", store);
  log("ebay_env", env);
  await cleanup(store);
  const photo = await samplePhoto(store);
  await makeUnit(store, "99081", {
    package_length_in: 12, package_width_in: 8, package_height_in: 6, package_weight_lb: 3, dims_source: "measured",
  }, photo);
  await makeUnit(store, "99082", { title: "Sandbox radio" }, photo);
  await makeUnit(store, "99083", { category: "Refrigerator", title: "Sandbox refrigerator", brand: "Test", model: "RF" }, photo);
  await makeUnit(store, "99084", { title: "Truly Hard Seltzer Variety", brand: "Truly", category: "Beverages" }, photo);
  await makeUnit(store, "99085", {
    title: "Sandbox clock", package_length_in: 18, package_width_in: 14, package_height_in: 10, package_weight_lb: 22, dims_source: "measured",
  }, photo);

  const sync = await syncDrafts(store, { quoteLimit: 5 });
  log("sync", sync);
  const { data: drafts } = await sb.from("ebay_drafts").select("sku,ready,shipping_mode,price_cents,label_cents,label_source,checklist").in("sku", SKUS);
  const bySku = Object.fromEntries((drafts || []).map((row) => [row.sku, row]));
  results.push(["draft small", Boolean(bySku["99081"])]);
  results.push(["needs box", Boolean(bySku["99082"]?.checklist?.some((item) => item.label === "Needs box size" && !item.ok))]);
  results.push(["fridge excluded", !bySku["99083"]]);
  results.push(["alcohol excluded", !bySku["99084"]]);
  results.push(["heavy uses calculated or free", Boolean(bySku["99085"]?.shipping_mode)]);
  log("modes", { small: bySku["99081"], heavy: bySku["99085"] });

  let lamp = await fillRequired(store, "99081");
  log("lamp ready", { ready: lamp.ready, fails: (lamp.checklist || []).filter((item) => !item.ok), mode: lamp.shipping_mode, price: lamp.price_cents, label: lamp.label_cents, source: lamp.label_source });
  if (!lamp.ready) throw new Error("lamp draft never became ready");
  let pushed = await pushDrafts(store, ["99081"]);
  log("push", pushed);
  if (!pushed[0]?.ok) {
    pushed = await pushDrafts(store, ["99081"]);
    log("push retry", pushed);
  }
  results.push(["push", Boolean(pushed[0]?.ok), pushed[0]?.error || pushed[0]?.viewUrl || ""]);
  if (pushed[0]?.ok) {
    const edited = await saveDraft(store, "99081", { title: "Sandbox desk lamp edited" });
    results.push(["edit", edited.title === "Sandbox desk lamp edited" && !edited.ebay_error, edited.ebay_error || edited.view_url || ""]);
    await endDraft(store, "99081");
    const { data: listing } = await sb.from("listings").select("status").eq("store_id", store).eq("sku", "99081").eq("channel", "ebay").maybeSingle();
    results.push(["end", listing?.status === "delisted"]);
  }

  const boxed = await saveBox(store, "99082", { length_in: 10, width_in: 8, height_in: 4, weight_lb: 2 });
  results.push(["box saved measured", boxed.box?.weight_lb === 2]);
  let radio = await fillRequired(store, "99082");
  if (radio.ready) {
    const salePush = await pushDrafts(store, ["99082"]);
    log("sale push", salePush);
    results.push(["sale listing", Boolean(salePush[0]?.ok), salePush[0]?.error || ""]);
    if (salePush[0]?.ok) {
      const ingested = await ingestEbayOrder(store, {
        orderId: "sandbox-test-99082",
        lineItems: [{ sku: "99082", lineItemCost: { value: "24.99" } }],
        pricingSummary: { priceSubtotal: { value: "24.99" }, deliveryCost: { value: "0.00" }, total: { value: "24.99" } },
        fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: "Test Buyer", contactAddress: { addressLine1: "1 Main St", city: "New York", stateOrProvince: "NY", postalCode: "10001", countryCode: "US" } } } }],
      });
      log("ingest", ingested);
      const { data: sold } = await sb.from("units").select("state").eq("store_id", store).eq("sku", "99082").maybeSingle();
      const { data: web } = await sb.from("storefront_items").select("sku").eq("store_id", store).eq("sku", "99082");
      const { data: order } = await sb.from("web_orders").select("order_no,channel,status").eq("store_id", store).eq("sku", "99082").maybeSingle();
      results.push(["ebay sale sold", sold?.state === "sold"]);
      results.push(["pulled from website", (web || []).length === 0]);
      results.push(["order in admin", order?.channel === "ebay" && order?.order_no === "sandbox-test-99082"]);
    }
  } else {
    results.push(["radio ready", false, (radio.checklist || []).filter((item) => !item.ok).map((item) => item.label).join("; ")]);
  }

  let clock = await fillRequired(store, "99085");
  if (clock.ready) {
    const regPush = await pushDrafts(store, ["99085"]);
    log("register push", regPush);
    if (regPush[0]?.ok) {
      const sale = await sb.rpc("finalize_sale", {
        p_sku: "99085", p_channel: "floor", p_price_cents: 4000, p_payment_method: "cash", p_note: "sandbox register",
      });
      log("register sale", sale.error ? sale.error.message : sale.data?.id);
      const withdrawn = await withdrawOpenEbayTasks();
      log("withdraw tasks", withdrawn);
      const { data: listing } = await sb.from("listings").select("status").eq("store_id", store).eq("sku", "99085").eq("channel", "ebay").maybeSingle();
      results.push(["register sale ended ebay", listing?.status === "delisted", sale.error?.message || ""]);
    } else results.push(["register listing", false, regPush[0]?.error || ""]);
  } else results.push(["clock ready", false]);
} catch (err) {
  log("FAILED", err instanceof Error ? err.stack || err.message : String(err));
  results.push(["script", false, err instanceof Error ? err.message : String(err)]);
} finally {
  if (store) await cleanup(store).catch((err) => log("cleanup", err.message));
}

log("RESULTS", results);
const bad = results.filter((row) => row[1] !== true);
if (bad.length) {
  console.error("FAILED CHECKS", JSON.stringify(bad));
  process.exit(1);
}
console.log("ALL SANDBOX CHECKS PASSED");
