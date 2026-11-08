/**
 * Shared shapes for dropship supplier adapters.
 * One adapter file per supplier; this is the contract they implement.
 */

/** @typedef {'cj'|'eprolo'|'doba'|'printify'} SupplierId */

/**
 * @typedef {object} CatalogPage
 * @property {CatalogItem[]} items
 * @property {number} page
 * @property {number} [totalPages]
 * @property {boolean} hasMore
 * @property {number} [pointsSpent]
 */

/**
 * @typedef {object} CatalogItem
 * @property {string} supplierProductId
 * @property {string|null} [supplierVariantId]
 * @property {string} title
 * @property {string|null} [brand]
 * @property {string|null} [category]
 * @property {string|null} [upc]
 * @property {string|null} [imageUrl]
 * @property {number} costCents
 * @property {number} [shippingCents]
 * @property {string|null} [warehouseId]
 * @property {string|null} [warehouseCountry]
 * @property {string|null} [warehouseCity]
 * @property {string|null} [warehouseRegion]
 * @property {string|null} [warehousePostal]
 * @property {boolean} shipsFromUs
 * @property {number|null} [processingDays]
 * @property {number} stockQty
 * @property {number|null} [weightOz]
 * @property {object} [raw]
 */

/**
 * @typedef {object} StockQuote
 * @property {boolean} inStock
 * @property {number} stockQty
 * @property {number} costCents
 * @property {number} shippingCents
 * @property {boolean} shipsFromUs
 * @property {object|null} [warehouse]
 */

/**
 * @typedef {object} ShipEstimate
 * @property {number} shippingCents
 * @property {number|null} [daysMin]
 * @property {number|null} [daysMax]
 * @property {string|null} [method]
 */

/**
 * @typedef {object} PlaceOrderInput
 * @property {string} externalOrderId
 * @property {string} supplierProductId
 * @property {string|null} [supplierVariantId]
 * @property {number} quantity
 * @property {{ name: string, phone?: string|null, line1: string, line2?: string|null, city: string, region: string, postal: string, country: string }} address
 * @property {string|null} [warehouseId]
 * @property {boolean} [blindShipping]
 * @property {string|null} [storeName]
 * @property {string|null} [remark]
 */

/**
 * @typedef {object} PlaceOrderResult
 * @property {string} supplierOrderId
 * @property {string} [status]
 * @property {number|null} [chargedCents]
 * @property {object} [raw]
 */

/**
 * @typedef {object} TrackingInfo
 * @property {string|null} trackingNumber
 * @property {string|null} [carrier]
 * @property {string|null} [status]
 * @property {object} [raw]
 */

/**
 * @typedef {object} AccountBalance
 * @property {number|null} balanceCents
 * @property {number|null} [pointsRemaining]
 * @property {string} currency
 */

/**
 * @typedef {object} SupplierAdapter
 * @property {SupplierId} id
 * @property {string} label
 * @property {boolean} enabled
 * @property {string} [statusHint]
 * @property {(ctx: object) => Promise<{ok:boolean, detail?:string}>} testConnection
 * @property {(ctx: object, opts: {page:number, size?:number, usOnly?:boolean}) => Promise<CatalogPage>} listCatalog
 * @property {(ctx: object, productId: string, variantId?: string|null) => Promise<CatalogItem|null>} getProduct
 * @property {(ctx: object, productId: string, variantId?: string|null) => Promise<StockQuote>} liveStock
 * @property {(ctx: object, input: object) => Promise<ShipEstimate>} shippingEstimate
 * @property {(ctx: object, input: PlaceOrderInput) => Promise<PlaceOrderResult>} placeOrder
 * @property {(ctx: object, supplierOrderId: string) => Promise<TrackingInfo>} getTracking
 * @property {(ctx: object) => Promise<AccountBalance>} getBalance
 */

export const SUPPLIER_IDS = /** @type {const} */ (["cj", "eprolo", "doba", "printify"]);

export function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isDropshipSku(sku) {
  return /^DS-\d+$/i.test(String(sku || "").trim());
}

export function dollarsToCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
