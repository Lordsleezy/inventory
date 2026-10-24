# One-click shipping labels (eBay / Amazon / TikTok / Website)

Floor price-shops every connected label source for the channel, buys the cheapest valid rate, pushes tracking, and logs the label cost to the ledger.

**Depop is not supported** (manual labels only).

---

## Owner setup checklist (exact clicks)

### 1) Shippo (already used for website — keep working)

1. Open [apps.goshippo.com](https://apps.goshippo.com/) → sign in.
2. **Settings → API** → copy the **live** token (`shippo_live_…`).
3. Netlify → site **inventoryobi** → **Site configuration → Environment variables**.
4. Set / replace `SHIPPO_API_KEY` = that live token (Functions scope + production context).
5. Confirm USPS / UPS / FedEx carrier accounts are connected under Shippo **Settings → Carriers**.
6. In Floor Admin → Settings, `ship_carriers` should list the carriers you want offered (default includes USPS).
7. Optional: set `SHIPPO_PLAN_NOTE` if you want a custom banner (otherwise Floor shows the API Starter note).
8. Redeploy inventoryobi functions after env changes (merge PR or Netlify deploy).

> Local `.env.local` may have a stale/invalid Shippo token. Production Netlify must hold a real **live** key.

### 2) Veeqo (shipping ONLY — inventory/listing sync OFF)

1. Create / sign in at [veeqo.com](https://www.veeqo.com/) (Amazon-owned). Stay on the free **Shipping** plan unless you need Inventory features (do **not** need Inventory for Floor labels).
2. **Settings → Integrations / Channels** → connect:
   - **eBay** — store username **ikonikdeals2026** (and any other selling accounts you use).
   - **Amazon** — seller account linked to Floor.
   - **TikTok Shop** — US shop.
3. For **each** channel connection in Veeqo:
   - Turn **OFF** inventory sync / stock push.
   - Turn **OFF** listing sync / listing publish.
   - Floor remains the only inventory source of truth.
4. **Settings → Billing / Payment** → add a payment method (required to buy labels).
5. **Settings → Shipping** → enable carriers you want Veeqo to quote (Amazon Shipping, UPS, FedEx, USPS, etc.).
6. **Developers / API** → create an API key (x-api-key).
7. Netlify **inventoryobi** → Environment variables → `VEEQO_API_KEY=<key>` (Functions + production).
8. Redeploy functions.

Floor uses Veeqo’s **Rate Shopping API** (`POST /shipping/api/v1/rates` + `/shipments`) so it does **not** need Veeqo to own Floor inventory. Marketplace connections in Veeqo still help Amazon Buy Shipping protections and cleaner channel rates.

### 3) Amazon SP-API Shipping v2 (fallback if Veeqo offline / no Buy Shipping)

1. Amazon Seller Central → **Apps and Services → Develop Apps** → your Floor SP-API app.
2. Request role: **Direct to Consumer Shipping (Restricted)**.
3. Wait for Amazon approval.
4. Netlify **inventoryobi** → set `AMAZON_SHIPPING_ENABLED=1` (LWA client id/secret/refresh already used for orders).
5. Redeploy functions.
6. Until approved, Floor shows Amazon Shipping as offline and still quotes Veeqo/Shippo.

**Path chosen:** Prefer Veeqo Rate Shopping for Amazon (Buy Shipping + claim/OTDR protection when Veeqo returns `protected`). Amazon SP-API Shipping v2 is the fallback when `AMAZON_SHIPPING_ENABLED=1` and Veeqo is offline/empty. If Veeqo never returns real Buy Shipping for your Amazon orders after setup, set the SP-API flag and use Amazon v2 as the Amazon-side source.

### 4) TikTok Shop Shipping (required for USPS on TikTok)

1. TikTok Seller Center (US) → **Shipping** → enable **Seller Shipping**.
2. Enable **TikTok Shipping** labels (TikTok’s carrier labels).
3. Partner Center → your Floor app → **Manage API** → ensure fulfillment / shipping-document scopes (at minimum seller fulfillment; add shipping-document scopes if listed).
4. Floor Admin → **Marketplaces → TikTok Shop** → re-authorize if scopes changed.
5. Optional Netlify: `TIKTOK_SHOP_SHOP_CIPHER` if authorized-shops lookup fails.
6. Rule since Jan 1, 2026: **USPS labels for TikTok orders must be bought through TikTok Shipping**. Floor filters out Shippo/Veeqo USPS for TikTok; UPS/FedEx may still come from Veeqo/Shippo.

### 5) eBay Sell Logistics (optional, later)

1. eBay Developer Program → apply for **Sell Logistics API** (limited release / restricted).
2. When approved, set Netlify `EBAY_LOGISTICS_ENABLED=1` and we can plug it in as a third eBay source (stub already in `netlify/lib/shipping/ebay-logistics.mjs`).
3. Until then Floor shows **eBay Logistics offline** and shops **Veeqo vs Shippo**.
4. Tracking already uses Fulfillment API `createShippingFulfillment` (tries selling account first, then other eBay accounts — e.g. ikonikdeals2026).

### 6) Label format preference

- Default: **4×6 thermal PDF** (`store_settings.label_format = PDF_4x6`) — already seeded.
- In Get label UI: toggle **4×6** vs **8.5×11**.
- Persists per store when you buy (`set_label_format` / buy payload).

### Env vars (Netlify `inventoryobi`, Functions scope)

| Variable | Purpose | Status at build time |
|----------|---------|----------------------|
| `SHIPPO_API_KEY` | Shippo live/test token | Present in prod (value redacted; verify it’s `shippo_live_…`) |
| `VEEQO_API_KEY` | Veeqo Rate Shopping | **Not set yet** |
| `AMAZON_SHIPPING_ENABLED` | `1` after SP-API shipping role | **Not set** |
| `AMAZON_LWA_*` / refresh | Existing Amazon auth | Present |
| TikTok OAuth tokens | In Supabase connections (not env) | Existing TikTok OAuth |
| `TIKTOK_SHOP_SHOP_CIPHER` | Optional shop cipher | Optional |
| `EBAY_LOGISTICS_ENABLED` | Future eBay Logistics | Not set (stub offline) |
| `SHIPPO_PLAN_NOTE` | Optional custom Shippo banner | Optional |

Until a source’s env/role is ready, Floor **skips it** in the quote and lists it as offline in the UI.

---

## What was built (locations)

### UI
- `apps/admin/src/LabelDialog.tsx` — Get label / Download·Reprint / Void; box confirm; multi-source quote; confirm cheapest; Buy; 4×6 vs letter; source online/offline + Shippo plan note.
- `apps/admin/src/OrdersPage.tsx` — desktop Orders **Get label** / **Download / Reprint label**.
- `apps/admin/src/appMode/AppOrders.tsx` — Floor app (phone / home-screen) same actions.

### Backend (Netlify functions site `inventoryobi`)
- `netlify/functions/web-order-admin.mjs` — `label_quote`, `buy_label`, `void_label`, `label_status`, `label_sources`, `set_label_format` (+ existing ship/cancel).
- `netlify/lib/web-label.mjs` — eligibility, buy lock, expense, void, website Shippo path preserved.
- `netlify/lib/shipping/quote-engine.mjs` — multi-source quote + buy.
- `netlify/lib/shipping/sources.mjs` — channel rules, cheapest pick, Amazon prefer-within-cents.
- `netlify/lib/shipping/veeqo.mjs` — Rate Shopping quote/buy.
- `netlify/lib/shipping/tiktok-shipping.mjs` — TikTok Shipping USPS (+ allowed TikTok services).
- `netlify/lib/shipping/amazon-shipping.mjs` — SP-API Shipping v2 fallback.
- `netlify/lib/shipping/ebay-logistics.mjs` — stub until approved.
- `netlify/lib/shipping/marketplace-tracking.mjs` — push tracking to eBay / Amazon / TikTok; skip if source already pushed.
- `netlify/lib/shippo.mjs` — existing website Shippo; plan note + quota heuristic.

### Schema
- Migration `supabase/migrations/20261023222043_one_click_shipping_labels.sql` (matches applied Floor DB version).
- `web_order_labels`: `source`, `label_format`, `purchase_token`, `external_shipment_id`, `quote_snapshot`, tracking-push audit columns.
- Unique **one active label per order** (`voided_at is null`).
- Unique `(store_id, purchase_token)` when token set.
- `web_orders.label_buying_at` claim lock (existing pattern hardened).
- `store_settings`: `label_format=PDF_4x6`, `label_amazon_prefer_cents=5`.
- `portal_web_orders` updated for label UI fields / multi-SKU box dims.

---

## Flow by channel

### Shared UI steps
1. Tap **Get label** → dialog opens with package L/W/H/weight from Floor units (`package_*` / unit dims). Blank dims block quoting.
2. Confirm/fix dims → **Get live rates** (never quotes on blanks).
3. Engine quotes all allowed online sources in parallel → filters illegal rates → auto-selects cheapest valid (Amazon: prefer protected within 5¢).
4. Confirm screen: carrier, service, days, label cost, buyer-paid shipping, difference. Expand other quotes to override.
5. **Buy** → purchase via winning source API → PDF URL → Download / Print.
6. Tracking pushed to marketplace; Floor order marked shipped (`shipped_at`).
7. `portal_expenses` Shipping row tied to `order_id` / sale for profit & payouts.

### eBay
- Sources: Veeqo, Shippo, eBay Logistics (offline stub).
- Buy cheapest; tracking via `createShippingFulfillment` on the owning eBay account (selling first, then others).

### Amazon
- Sources: Veeqo (Buy Shipping / protected when available), Shippo, Amazon SP-API v2 if enabled.
- Prefer Amazon/Veeqo within `label_amazon_prefer_cents` (default 5).
- Tracking via SP-API confirm shipment / order fulfillment path in `marketplace-tracking.mjs`.

### TikTok Shop
- Sources: TikTok Shipping (USPS must be here), Veeqo, Shippo.
- Shippo/Veeqo **USPS rates filtered out**.
- Tracking/ship via TikTok package APIs; skip double-push if TikTok buy already created the package.

### Website
- Shippo only (unchanged path). Condition OK required. Existing Oct 3 flow preserved.

---

## Double-purchase, void, reprint

- **Claim lock:** `label_buying_at` on `web_orders` — only one buyer if tracking/label still null; stale lock expires ~2 min.
- **DB unique:** one non-voided row in `web_order_labels` per `order_id`.
- **Idempotency:** client `purchase_token` (UUID per dialog open); replay returns existing label.
- **UI:** once `label_url` exists → **Download / Reprint** only (no second Buy).
- **Void:** refund via source API (Shippo refund; Veeqo/TikTok/Amazon best-effort); expense voided/reversed; tracking cleared; refuse void after `delivered_at`.
- **Reprint:** opens existing `label_url` — never re-purchases.

---

## Costs / caps / limits

| Source | Notes |
|--------|--------|
| **Shippo API Starter** | ~30 labels/mo free, then ~7¢/label (+ postage). Rating/tracking add-ons may bill separately. **Not a hard cut-off** on API — monitor billing. Floor surfaces a plan note and skips Shippo on payment/quota-like errors so Veeqo can win. Could not inspect your live Shippo dashboard plan from this environment (Netlify redacts the key). |
| **Veeqo Shipping plan** | Free for shipping; no API fee; you pay label postage. Keep **Inventory** plan off if you don’t need it — turn sync OFF either way. Up to ~5% Veeqo Credits / Amazon protections on eligible Buy Shipping. |
| **Amazon Buy Shipping / SP-API** | Label cost = carrier rate; Restricted role required for direct Shipping v2. |
| **TikTok Shipping** | Carrier rates via TikTok; USPS must go through TikTok for TikTok orders (policy). |
| **eBay Logistics** | N/A until approved. |

---

## Testing (this agent)

| Test | Result |
|------|--------|
| `node --test netlify/lib/shipping/sources.test.mjs` | Pass (channel rules, TikTok USPS filter, Amazon prefer, Shippo quota heuristic) |
| `node --test netlify/lib/web-label.test.mjs` | Pass (quote/buy/expense/void/anti-condition; delivered void 409) |
| Migration applied on Floor Supabase | Yes — label columns + `label_format` / prefer-cents settings |
| Deploy preview admin | https://deploy-preview-104--openbox-floor-admin.netlify.app |
| Deploy preview functions | https://deploy-preview-104--inventoryobi.netlify.app |
| Live multi-source quote with Veeqo | **Blocked** — `VEEQO_API_KEY` not in Netlify yet |
| Live Shippo account/plan probe | **Blocked** — Netlify CLI redacts `SHIPPO_API_KEY`; local key invalid |
| Prod functions deploy from this branch | **Blocked** by `not_on_master` deploy guard — merge PR #104 to master (or approved prod deploy) |

---

## Sketchy / follow-ups noticed

1. **Prod functions still need merge** — admin preview is up; production `inventoryobi` functions update when #104 lands on master.
2. **`VEEQO_API_KEY` missing** — until set, eBay/Amazon/TikTok quotes are Shippo-only (plus TikTok Shipping if OAuth scopes OK).
3. **Local Shippo token invalid** — do not copy `.env.local` over prod.
4. **Amazon Shipping role** — not requested yet; SP-API v2 stays offline until you finish checklist §3.
5. **Veeqo inventory sync** — human must turn OFF in Veeqo UI; Floor cannot enforce that remotely.
6. **eBay Logistics** — stub only; apply when ready.
7. Untracked junk `apps/admin/netlify/package-lock.json` left uncommitted (build artifact).
