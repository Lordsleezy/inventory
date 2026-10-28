import { serviceClient } from "./server.mjs";
import { tiktokApiFetch } from "./tiktok-shop.mjs";

const mustOk = (json, label) => {
  if (!json || json.code !== 0) throw new Error(json?.message || `${label}_failed`);
  return json.data || {};
};

async function collectPages(storeId, path, body, key) {
  const rows = []; let token = null;
  for (let i = 0; i < 100; i++) {
    const pageBody = { ...body, ...(token ? { page_token: token } : {}) };
    const data = mustOk(await tiktokApiFetch(storeId, "POST", path, pageBody), key);
    rows.push(...(data[key] || []));
    token = data.next_page_token || data.nextPageToken || null;
    if (!token) return rows;
  }
  throw new Error(`${key}_pagination_limit`);
}

async function saveSnapshots(storeId, type, rows, keyOf) {
  const sb = serviceClient(); const now = new Date().toISOString();
  const payload = rows.map((row, i) => ({ store_id: storeId, snapshot_type: type,
    snapshot_key: String(keyOf(row) || `row-${i}`), payload: row, captured_at: now }));
  for (let i = 0; i < payload.length; i += 250) {
    const { error } = await sb.from("tiktok_shop_snapshots").upsert(payload.slice(i, i + 250),
      { onConflict: "store_id,snapshot_type,snapshot_key" });
    if (error) throw new Error(error.message);
  }
  return payload.length;
}

/** Sync settled payouts (idempotently) and the platform's explicitly estimated unsettled balance. */
export async function syncTikTokFinance(storeId) {
  const paymentRows = []; let paymentToken = null;
  const now = Math.floor(Date.now() / 1000); const paymentFrom = now - 365 * 24 * 60 * 60;
  for (let page = 0; page < 100; page++) {
    const params = { create_time_ge: paymentFrom, create_time_lt: now, page_size: 100,
      sort_field: "create_time", sort_order: "ASC", ...(paymentToken ? { page_token: paymentToken } : {}) };
    const data = mustOk(await tiktokApiFetch(storeId, "GET", "/finance/202605/payments", null, params), "finance_payments");
    paymentRows.push(...(data.payments || [])); paymentToken = data.next_page_token || null; if (!paymentToken) break;
  }
  await saveSnapshots(storeId, "finance_payments", paymentRows, (x) => `payment-${x.id}`);
  let payoutImports = 0;
  for (const payment of paymentRows) {
    const payout = normalizeBooksPayout("tiktok", payment);
    if (payout && (await saveBooksPayout(serviceClient(), storeId, payout)).imported) payoutImports++;
  }
  const unsettled = [];
  for (let from = paymentFrom; from < now; from += 30 * 24 * 60 * 60) {
    let pageToken = null;
    for (let page = 0; page < 100; page++) {
      const params = { search_time_ge: from, search_time_lt: Math.min(now, from + 30 * 24 * 60 * 60),
        sort_field: "create_time", sort_order: "ASC", page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) };
      const data = mustOk(await tiktokApiFetch(storeId, "GET", "/finance/202507/orders/unsettled", null, params), "finance_unsettled");
      unsettled.push(...(data.transactions || [])); pageToken = data.next_page_token || null; if (!pageToken) break;
    }
  }
  await saveSnapshots(storeId, "finance_payments", unsettled, (x) => `unsettled-${x.id}`);
  const balanceCents = unsettled.reduce((sum, row) => String(row.currency || "USD").toUpperCase() === "USD"
    ? sum + Math.round(Number(row.est_settlement_amount || row.estimated_settlement_amount || 0) * 100) : sum, 0);
  const { error } = await serviceClient().from("money_account_sync").upsert({
    store_id: storeId, account: "tiktok", balance_cents: balanceCents,
    detail: { estimated_unsettled_cents: balanceCents, unsettled_transactions: unsettled.length,
      paid_payments_seen: paymentRows.length, payout_rows_imported: payoutImports,
      note: "TikTok unsettled amount is an estimate that can change before settlement; PAID payment records are imported separately by payment ID." },
    status: "ok", message: "TikTok unsettled amount is an estimate; payments are imported by unique payout ID.", synced_at: new Date().toISOString(),
  }, { onConflict: "store_id,account" });
  if (error) throw new Error(error.message);
  return { payments: paymentRows.length, unsettled: unsettled.length, payoutRowsImported: payoutImports, estimatedUnsettledCents: balanceCents };
}

/** Pulls shop-owned data without creating or modifying any TikTok product/order. */
export async function syncTikTokPrepData(storeId) {
  const summaries = {};
  const shopsData = mustOk(await tiktokApiFetch(storeId, "GET", "/authorization/202309/shops"), "shops");
  const shops = shopsData.shops || [];
  summaries.shops = await saveSnapshots(storeId, "shop", shops, (x) => x.id || x.shop_id);

  const warehousesData = mustOk(await tiktokApiFetch(storeId, "GET", "/logistics/202309/global_warehouses"), "warehouses");
  const warehouses = warehousesData.warehouses || [];
  summaries.warehouses = await saveSnapshots(storeId, "warehouses", warehouses, (x) => x.id || x.warehouse_id);

  const products = await collectPages(storeId, "/product/202309/products/search", { page_size: 100 }, "products");
  summaries.products = await saveSnapshots(storeId, "products", products, (x) => x.id || x.product_id);

  const brands = []; let brandToken = null;
  for (let page = 0; page < 100; page++) {
    const params = { page_size: 100, category_version: "v2", ...(brandToken ? { page_token: brandToken } : {}) };
    const data = mustOk(await tiktokApiFetch(storeId, "GET", "/product/202309/brands", null, params), "brands");
    brands.push(...(data.brands || [])); brandToken = data.next_page_token || null; if (!brandToken) break;
  }
  // Global brand status does not prove authorization in an item's category. Save category-scoped
  // results separately so readiness can verify exact brand/category authorization later.
  const { data: mappings, error: mappingError } = await serviceClient().from("unit_channel_categories")
    .select("category_id").eq("store_id", storeId).eq("channel", "tiktok").eq("enabled", true).not("category_id", "is", null);
  if (mappingError) throw new Error(mappingError.message);
  const categoryIds = [...new Set((mappings || []).map((row) => row.category_id).filter(Boolean))];
  const categoryBrands = [];
  for (const categoryId of categoryIds) {
    let token = null;
    for (let page = 0; page < 100; page++) {
      const params = { page_size: 100, category_id: categoryId, category_version: "v2",
        ...(token ? { page_token: token } : {}) };
      const data = mustOk(await tiktokApiFetch(storeId, "GET", "/product/202309/brands", null, params), `brands_${categoryId}`);
      categoryBrands.push(...(data.brands || []).map((brand) => ({ ...brand, category_id: categoryId })));
      token = data.next_page_token || null;
      if (!token) break;
    }
  }
  summaries.brands = await saveSnapshots(storeId, "brands", [...brands, ...categoryBrands],
    (x) => x.category_id ? `category-${x.category_id}-brand-${x.id || x.brand_id}` : `global-brand-${x.id || x.brand_id}`);

  const now = Math.floor(Date.now() / 1000);
  const since = now - 365 * 24 * 60 * 60;
  const orders = [];
  for (let from = since; from < now; from += 30 * 24 * 60 * 60) {
    orders.push(...await collectPages(storeId, "/order/202309/orders/search", { page_size: 100,
      create_time_ge: from, create_time_lt: Math.min(now, from + 30 * 24 * 60 * 60) }, "orders"));
  }
  summaries.orders = await saveSnapshots(storeId, "orders", orders, (x) => x.id || x.order_id);

  // TikTok Shipping service choices are order/package-specific. Floor cannot query eligible services without an order ID and parcel details.
  // Save that fact alongside the shop logistics options without fabricating a universal delivery list.
  const seenShipping = new Map();
  for (const order of orders) {
    const option = { shipping_type: order.shipping_type || null, delivery_option: order.delivery_option || null,
      delivery_option_name: order.delivery_option_name || null, shipping_provider: order.shipping_provider || null };
    const key = JSON.stringify(option);
    if (Object.values(option).some(Boolean)) seenShipping.set(key, option);
  }
  summaries.shipping = await saveSnapshots(storeId, "shipping", [
    ...[...seenShipping.values()], { note: "Shipping service eligibility is order/package-specific; query after an order exists using its dimensions and weight.", warehouse_count: warehouses.length },
  ], (x, i) => x.note ? "availability-note" : `order-delivery-${i}`);
  return { ok: true, counts: summaries, shippingOptions: "order-specific; no universal options endpoint for this US seller workflow" };
}
