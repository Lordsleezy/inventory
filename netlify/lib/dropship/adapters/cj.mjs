import { ThrottledQueue, CJ_POINTS } from "../throttle.mjs";
import { dollarsToCents, normalizeTitle } from "../types.mjs";

const BASE = "https://developers.cjdropshipping.com/api2.0/v1";

/**
 * CJ Dropshipping adapter (fully wired).
 * Auth: API key → access/refresh tokens (header CJ-Access-Token).
 * Free tier: QPS≈1, points quota, 429 on exhaustion, 3 users/IP.
 * Prefer US warehouse inventory via countryCode=US + isWarehouse=true.
 *
 * Packing slip / branded invoice: CJ marketing claims blind shipping + custom
 * packaging exist in My CJ, but createOrderV2/V3 expose no packing-slip seller
 * name field we can verify. Fail-closed for eBay until settings.cj_blind_shipping_verified.
 */
export const cjAdapter = {
  id: "cj",
  label: "CJ Dropshipping",
  enabled: true,

  async testConnection(ctx) {
    const token = await ensureAccessToken(ctx);
    const res = await cjFetch(ctx, "GET", "/product/listV2", { page: 1, size: 1, countryCode: "US", isWarehouse: true }, token);
    return { ok: true, detail: `ok page=${res?.data?.pageNumber || 1}` };
  },

  async listCatalog(ctx, opts = {}) {
    const page = Math.max(1, Number(opts.page) || 1);
    const size = Math.min(100, Math.max(1, Number(opts.size) || 50));
    if (!ctx.queue.canSpend(CJ_POINTS.LIST)) {
      return { items: [], page, hasMore: false, pointsSpent: 0, stopped: "points_budget" };
    }
    const token = await ensureAccessToken(ctx);
    const params = {
      page,
      size,
      countryCode: "US",
      isWarehouse: true,
      startWarehouseInventory: 1,
      verifiedWarehouse: 1,
      features: ["enable_category"],
    };
    const res = await ctx.queue.withBackoff(() => cjFetch(ctx, "GET", "/product/listV2", params, token));
    ctx.queue.recordSpend(CJ_POINTS.LIST);
    const rows = flattenListV2(res?.data);
    const items = rows.map((row) => mapListRow(row));
    const totalPages = Number(res?.data?.totalPages) || page;
    return {
      items,
      page,
      totalPages,
      hasMore: page < totalPages && items.length > 0,
      pointsSpent: CJ_POINTS.LIST,
    };
  },

  async getProduct(ctx, productId, variantId = null) {
    if (!ctx.queue.canSpend(CJ_POINTS.QUERY)) return null;
    const token = await ensureAccessToken(ctx);
    const res = await ctx.queue.withBackoff(() =>
      cjFetch(ctx, "GET", "/product/query", { pid: productId }, token),
    );
    ctx.queue.recordSpend(CJ_POINTS.QUERY);
    const data = res?.data;
    if (!data) return null;
    return mapProductDetail(data, variantId);
  },

  async liveStock(ctx, productId, variantId = null) {
    const detail = await this.getProduct(ctx, productId, variantId);
    if (!detail) {
      return { inStock: false, stockQty: 0, costCents: 0, shippingCents: 0, shipsFromUs: false, warehouse: null };
    }
    return {
      inStock: detail.stockQty > 0 && detail.shipsFromUs,
      stockQty: detail.stockQty,
      costCents: detail.costCents,
      shippingCents: detail.shippingCents || 0,
      shipsFromUs: detail.shipsFromUs,
      warehouse: detail.warehouseId
        ? {
            id: detail.warehouseId,
            country: detail.warehouseCountry,
            city: detail.warehouseCity,
            region: detail.warehouseRegion,
            postal: detail.warehousePostal,
          }
        : null,
    };
  },

  async shippingEstimate(ctx, input) {
    // Prefer freight inquiry when we have vid + zip; fall back to listed shipping.
    try {
      const token = await ensureAccessToken(ctx);
      const body = {
        startCountryCode: "US",
        endCountryCode: input?.address?.country || "US",
        products: [
          {
            quantity: input?.quantity || 1,
            vid: input?.supplierVariantId || undefined,
            sku: input?.sku || undefined,
          },
        ],
        zip: input?.address?.postal || undefined,
      };
      const res = await ctx.queue.withBackoff(() =>
        cjFetch(ctx, "POST", "/logistic/freightCalculate", body, token),
      );
      const first = Array.isArray(res?.data) ? res.data[0] : res?.data?.[0] || res?.data;
      const cents = dollarsToCents(first?.logisticPrice ?? first?.price ?? 0);
      return {
        shippingCents: cents,
        daysMin: numOrNull(first?.logisticAging || first?.aging),
        daysMax: numOrNull(first?.logisticAging || first?.aging),
        method: first?.logisticName || first?.name || null,
      };
    } catch {
      return { shippingCents: Number(input?.fallbackShippingCents) || 0, daysMin: null, daysMax: null, method: null };
    }
  },

  async placeOrder(ctx, input) {
    const token = await ensureAccessToken(ctx);
    const addr = input.address || {};
    if (!addr.name || !addr.line1 || !addr.city || !addr.region || !addr.postal || !addr.country) {
      const err = new Error("bad_address");
      err.code = "bad_address";
      throw err;
    }
    if (!input.supplierVariantId && !input.sku) {
      const err = new Error("variant_required");
      err.code = "variant_required";
      throw err;
    }
    const body = {
      orderNumber: String(input.externalOrderId).slice(0, 50),
      shippingZip: addr.postal,
      shippingCountry: addr.country === "US" ? "United States" : addr.country,
      shippingCountryCode: addr.country || "US",
      shippingProvince: addr.region,
      shippingCity: addr.city,
      shippingPhone: addr.phone || "0000000000",
      shippingCustomerName: addr.name,
      shippingAddress: addr.line1,
      shippingAddress2: addr.line2 || "",
      fromCountryCode: "US",
      payType: 2, // balance — bot never tops up
      shopLogisticsType: 2,
      storageId: input.warehouseId || undefined,
      // storeName must match a configured CJ API store; remark is the only free-text hint.
      storeName: input.storeName || undefined,
      remark: input.remark || "Blind ship. Packing slip / invoice: Open Box Industries only. No supplier branding.",
      products: [
        {
          vid: input.supplierVariantId || undefined,
          sku: input.sku || undefined,
          quantity: input.quantity || 1,
        },
      ],
    };
    const res = await ctx.queue.withBackoff(() =>
      cjFetch(ctx, "POST", "/shopping/order/createOrderV2", body, token),
    );
    if (!res?.success && res?.code !== 200) {
      const err = new Error(res?.message || "place_order_failed");
      err.code = res?.code;
      err.body = res;
      throw err;
    }
    const data = res?.data || {};
    const orderId = data.orderId || data.orderCode || data.cjOrderId || data[0]?.orderId;
    if (!orderId) {
      const err = new Error("missing_supplier_order_id");
      err.body = res;
      throw err;
    }
    return {
      supplierOrderId: String(orderId),
      status: data.orderStatus || "placed",
      chargedCents: dollarsToCents(data.productAmount || data.amount || 0),
      raw: data,
    };
  },

  async getTracking(ctx, supplierOrderId) {
    const token = await ensureAccessToken(ctx);
    const res = await ctx.queue.withBackoff(() =>
      cjFetch(ctx, "GET", "/logistic/getTrackInfo", { orderId: supplierOrderId }, token),
    );
    const data = res?.data;
    const first = Array.isArray(data) ? data[0] : data;
    return {
      trackingNumber: first?.trackingNumber || first?.trackNumber || null,
      carrier: first?.logisticName || first?.carrier || null,
      status: first?.status || first?.trackStatus || null,
      raw: data,
    };
  },

  async getBalance(ctx) {
    const token = await ensureAccessToken(ctx);
    // CJ balance endpoint varies by account; try settings balance then fall back to stored.
    try {
      const res = await ctx.queue.withBackoff(() =>
        cjFetch(ctx, "GET", "/shopping/pay/getBalance", {}, token),
      );
      const cents = dollarsToCents(res?.data?.amount ?? res?.data?.balance ?? res?.data);
      await ctx.saveTokens({ balanceCents: cents, pointsRemaining: ctx.pointsRemaining });
      return { balanceCents: cents, pointsRemaining: ctx.pointsRemaining ?? null, currency: "USD" };
    } catch {
      return {
        balanceCents: ctx.balanceCents ?? null,
        pointsRemaining: ctx.pointsRemaining ?? null,
        currency: "USD",
      };
    }
  },
};

export function createCjContext(baseCtx) {
  const queue = new ThrottledQueue({
    pointsRemaining: baseCtx.pointsRemaining ?? null,
    maxPointsPerRun: 8000,
    softFloor: 2000,
  });
  return { ...baseCtx, queue };
}

async function ensureAccessToken(ctx) {
  const exp = ctx.row?.token_expires_at ? new Date(ctx.row.token_expires_at).getTime() : 0;
  if (ctx.accessToken && exp > Date.now() + 60_000) return ctx.accessToken;

  if (ctx.refreshToken) {
    try {
      const refreshed = await rawPost("/authentication/refreshAccessToken", {
        refreshToken: ctx.refreshToken,
      });
      if (refreshed?.data?.accessToken) {
        await ctx.saveTokens(refreshed.data);
        ctx.accessToken = refreshed.data.accessToken;
        ctx.refreshToken = refreshed.data.refreshToken || ctx.refreshToken;
        return ctx.accessToken;
      }
    } catch {
      /* fall through to api key */
    }
  }

  if (!ctx.apiKey) {
    const err = new Error("cj_api_key_missing");
    err.code = "cj_api_key_missing";
    throw err;
  }
  const got = await rawPost("/authentication/getAccessToken", { apiKey: ctx.apiKey });
  if (!got?.data?.accessToken) {
    const err = new Error(got?.message || "cj_auth_failed");
    err.code = got?.code || "cj_auth_failed";
    err.body = got;
    throw err;
  }
  await ctx.saveTokens(got.data);
  ctx.accessToken = got.data.accessToken;
  ctx.refreshToken = got.data.refreshToken;
  return ctx.accessToken;
}

async function rawPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 429) {
    const err = new Error("rate_limited");
    err.status = 429;
    err.code = json?.code || 1600200;
    err.body = json;
    throw err;
  }
  if (!res.ok && res.status >= 500) {
    const err = new Error("cj_upstream");
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function cjFetch(ctx, method, path, params, token) {
  let url = `${BASE}${path}`;
  const init = {
    method,
    headers: {
      "CJ-Access-Token": token,
      "Content-Type": "application/json",
    },
  };
  if (method === "GET") {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const item of v) q.append(k, String(item));
      } else if (typeof v === "boolean") {
        q.set(k, v ? "true" : "false");
      } else {
        q.set(k, String(v));
      }
    }
    url += `?${q.toString()}`;
  } else {
    init.body = JSON.stringify(params || {});
  }
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (res.status === 429 || json?.code === 1600200 || json?.code === 16900500) {
    const err = new Error(json?.message || "rate_limited");
    err.status = 429;
    err.code = json?.code || 1600200;
    err.body = json;
    throw err;
  }
  if (json?.code === 1600001 || json?.code === 1600003) {
    // auth failed / refresh failed — clear token so next call re-auths
    ctx.accessToken = null;
    const err = new Error(json?.message || "token_expired");
    err.status = 401;
    err.code = json.code;
    err.body = json;
    throw err;
  }
  if (res.status >= 400 && !json?.success) {
    const err = new Error(json?.message || `cj_http_${res.status}`);
    err.status = res.status;
    err.code = json?.code;
    err.body = json;
    throw err;
  }
  return json;
}

function flattenListV2(data) {
  const content = data?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    const list = block?.productList || (block?.id ? [block] : []);
    for (const row of list) out.push(row);
  }
  return out;
}

function mapListRow(row) {
  const cost = dollarsToCents(row.nowPrice ?? row.discountPrice ?? row.sellPrice ?? 0);
  const delivery = String(row.deliveryCycle || "");
  const days = parseDeliveryDays(delivery);
  return {
    supplierProductId: String(row.id),
    supplierVariantId: null,
    title: String(row.nameEn || row.name || row.sku || "Untitled"),
    brand: null,
    category: row.threeCategoryName || row.twoCategoryName || row.oneCategoryName || null,
    upc: null,
    imageUrl: row.bigImage || null,
    costCents: cost,
    shippingCents: row.addMarkStatus === 1 ? 0 : 0,
    warehouseId: null,
    warehouseCountry: "US",
    warehouseCity: null,
    warehouseRegion: null,
    warehousePostal: null,
    shipsFromUs: true, // list filtered countryCode=US + isWarehouse
    processingDays: days,
    stockQty: Number(row.warehouseInventoryNum || row.totalVerifiedInventory || 0),
    weightOz: null,
    raw: row,
  };
}

function mapProductDetail(data, variantId) {
  const variants = data.variants || data.productSkuReqs || data.productVariantList || [];
  const variant =
    (variantId && variants.find((v) => String(v.vid || v.id) === String(variantId))) || variants[0] || {};
  const inventories = variant.inventory || variant.inventories || data.inventories || [];
  const usInv = (Array.isArray(inventories) ? inventories : []).find(
    (inv) => String(inv.countryCode || inv.country || "").toUpperCase() === "US",
  );
  const stockQty = Number(
    usInv?.totalInventoryNum ?? usInv?.cjInventoryNum ?? variant.warehouseInventoryNum ?? data.warehouseInventoryNum ?? 0,
  );
  const warehouse = usInv || {};
  const cost = dollarsToCents(variant.nowPrice ?? variant.sellPrice ?? data.nowPrice ?? data.sellPrice ?? 0);
  return {
    supplierProductId: String(data.pid || data.id || data.productId),
    supplierVariantId: variant.vid || variant.id ? String(variant.vid || variant.id) : null,
    title: String(data.productNameEn || data.nameEn || data.name || "Untitled"),
    brand: data.brand || variant.brand || null,
    category: data.categoryName || null,
    upc: variant.barcode || variant.upc || null,
    imageUrl: (Array.isArray(data.productImage) ? data.productImage[0] : data.bigImage) || null,
    costCents: cost,
    shippingCents: 0,
    warehouseId: warehouse.areaId != null ? String(warehouse.areaId) : warehouse.stockId || null,
    warehouseCountry: "US",
    warehouseCity: warehouse.city || warehouse.areaEn || null,
    warehouseRegion: warehouse.state || warehouse.province || warehouse.region || null,
    warehousePostal: warehouse.zip || warehouse.postalCode || null,
    shipsFromUs: Boolean(usInv) || String(data.countryCode || "").toUpperCase() === "US",
    processingDays: parseDeliveryDays(data.deliveryCycle || variant.deliveryCycle),
    stockQty,
    weightOz: variant.weight ? Number(variant.weight) * 35.274 : null, // kg→oz if kg
    raw: { product: data, variant },
  };
}

function parseDeliveryDays(cycle) {
  if (!cycle) return null;
  const m = String(cycle).match(/(\d+)\s*[-–]\s*(\d+)/) || String(cycle).match(/(\d+)/);
  if (!m) return null;
  return Number(m[2] || m[1]);
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const __test = {
  flattenListV2,
  mapListRow,
  mapProductDetail,
  parseDeliveryDays,
  normalizeTitle,
};
