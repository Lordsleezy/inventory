# One-click shipping labels (eBay / Amazon / TikTok / Website)

Floor price-shops every connected label source for the channel, buys the cheapest valid rate, pushes tracking, and logs the label cost to the ledger.

**Depop is not supported** (manual labels only).

## Owner setup checklist

### 1) Shippo (already used for website)

1. Open [Shippo](https://apps.goshippo.com/) → Settings → API.
2. Copy the **live** API token (`shippo_live_…`).
3. Netlify → site **inventoryobi** → Site configuration → Environment variables → set `SHIPPO_API_KEY`.
4. Confirm carrier accounts (USPS/UPS/FedEx) are connected in Shippo.
5. Floor Settings → shipping carriers (`ship_carriers`) should list the carriers you want offered (default USPS).

> Local `.env.local` currently has an invalid Shippo token (`Token does not exist`). Production Netlify must hold a real live key or website quotes stay offline.

### 2) Veeqo (shipping only — inventory sync OFF)

1. Create / sign in at [Veeqo](https://www.veeqo.com/) (Amazon-owned).
2. Connect marketplaces inside Veeqo: **eBay** (`ikonikdeals2026`), **Amazon**, **TikTok Shop**.
3. For each channel connection in Veeqo: turn **OFF** inventory sync, listing sync, and any stock push. Floor is the only inventory source of truth.
4. Add a payment method under Veeqo billing (required to buy labels).
5. Settings → Shipping: enable the carriers you want Veeqo to quote (Amazon Shipping / UPS / FedEx / etc.).
6. Developers → API → create an API key.
7. Netlify **inventoryobi** env: `VEEQO_API_KEY=<key>`.
8. Redeploy functions (or wait for the next git deploy).

Floor uses Veeqo’s **Rate Shopping API** (`/shipping/api/v1/rates` + `/shipments`) so it does **not** need Veeqo to own Floor inventory. Marketplace connections in Veeqo are still required for Amazon Buy Shipping protections and cleaner channel rates.

### 3) Amazon SP-API Shipping v2 (fallback if Veeqo offline)

1. Seller Central → Apps and Services → Develop Apps → your Floor app.
2. Request role: **Direct to Consumer Shipping (Restricted)**.
3. After Amazon approves, set Netlify env `AMAZON_SHIPPING_ENABLED=1` (LWA client id/secret/refresh token already used for orders).
4. Until approved, Floor shows Amazon Shipping as offline and still quotes Veeqo/Shippo.

### 4) TikTok Shop Shipping (required for USPS on TikTok)

1. Seller Center (US) → Shipping → enable **Seller Shipping** and **TikTok Shipping** labels.
2. Partner Center → your app → Manage API → ensure fulfillment scopes include shipping / packages (at minimum `seller.fulfillment.basic`; add shipping-document scopes if Partner Center lists them).
3. Re-authorize Admin → Marketplaces → TikTok Shop if scopes change.
4. Optional Netlify: `TIKTOK_SHOP_SHOP_CIPHER` if authorized-shops lookup fails.
5. TikTok rule (since Jan 2026): **USPS labels for TikTok orders must be bought through TikTok Shipping**. Floor enforces this (Shippo/Veeqo USPS rates are filtered out for TikTok).

### 5) eBay Sell Logistics (optional, later)

1. eBay Developer Program → apply for **Sell Logistics API** (limited release / restricted).
2. When approved, we can turn on `EBAY_LOGISTICS_ENABLED=1` and plug it in as a third eBay source. Until then Floor shows **eBay Logistics offline** and shops **Veeqo vs Shippo**.
3. Tracking already goes through Fulfillment API `createShippingFulfillment` on buy (right eBay account tried: selling first, then others).

### 6) Label format preference

- Default: **4×6 thermal PDF** (`store_settings.label_format = PDF_4x6`).
- In Get label UI: toggle **4×6** vs **8.5×11**.
- Persists per store when you buy.

## Env vars (Netlify `inventoryobi`)

| Variable | Purpose |
|----------|---------|
| `SHIPPO_API_KEY` | Shippo live/test token |
| `VEEQO_API_KEY` | Veeqo Rate Shopping |
| `AMAZON_SHIPPING_ENABLED` | `1` after SP-API shipping role approved |
| `AMAZON_LWA_*` / refresh | Existing Amazon auth |
| `TIKTOK_SHOP_*` | Existing TikTok auth |
| `TIKTOK_SHOP_SHOP_CIPHER` | Optional shop cipher |
| `EBAY_LOGISTICS_ENABLED` | Future eBay Logistics |

Until a source’s env/role is ready, Floor **skips it** in the quote and lists it as offline in the UI.
