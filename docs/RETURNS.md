# Returns system (Floor)

Channel-agnostic returns for Amazon, TikTok Shop, website, eBay, Mercari, and the rest.
Garage receiving lives under **Admin → Orders → Returns**.

## What you must do by hand

### Amazon (MFN returns report)

1. In Seller Central → Apps & Services → Develop Apps, open the Floor SP-API app.
2. Confirm the app has **Inventory and Order Tracking** (and **Direct to Consumer Shipping** if Amazon requires it for returns reports).
3. If Roles were just added, re-authorize the app so the refresh token picks up the new roles.
4. Keep existing Netlify env vars (`AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_REFRESH_TOKEN` / connections row, `AMAZON_SELLER_ID`).
5. Optional: `AMAZON_RETURNS_LOOKBACK_DAYS` (default 14, max 60).
6. After deploy, hit `POST https://inventoryobi.netlify.app/.netlify/functions/returns-sync` with `{"action":"status"}` then a plain POST to run once.
7. Confirm a test RMA appears under **Orders → Returns** and that `return_decision` email hits `obitracking@gmail.com` (Gmail SMTP / `FLOOR_OWNER_EMAIL`).

### TikTok Shop (not connected yet)

1. Create a TikTok Shop Partner account and register an app for Open Box Industries.
2. Request **Orders** + **Return/Refund** scopes; complete app review and shop authorization (US).
3. Set Netlify env: `TIKTOK_SHOP_APP_KEY`, `TIKTOK_SHOP_APP_SECRET`, `TIKTOK_SHOP_ACCESS_TOKEN`, `TIKTOK_SHOP_SHOP_ID`.
4. Redeploy Netlify. Status: `GET/POST .../tiktok-returns-sync` with `{"action":"status"}`.
5. When Partner API paths for your region/version are confirmed, the stub in `netlify/lib/tiktok-shop.mjs` is ready to wire the live search → `ingest_channel_return`.
6. Decision clock defaults to **48 hours** (`return_settings.decision_hours.tiktok`).

### Dropship bot branch

`feat/dropship-bot` was **not** on the remote when this shipped. Use:

- Table `suppliers` (+ `units.supplier_id`)
- RPC `supplier_return_policy_check(store_id, supplier_id)` before listing
- Admin **Settings → Returns → Dropship suppliers**

### Ops

1. Open **Settings → Returns**: reserve % (Amazon/TikTok default 10%), refund-without-return threshold.
2. Train garage flow: **Orders → Returns** → scan SKU/order → inspect → photo → disposition.
3. For Amazon/TikTok ship-outs: pack-time photo (serial optional) is required before **Mark shipped**.

## Architecture notes

- Same SKU reopens on restock; never mint a new SKU for a returned unit.
- Refunded sales call `return_reverse_sale` → `sales.voided_at` so payouts/commission drop that sale (same as other voids). Buyer-keeps / write-off sets unit `lost`/`scrapped` without relist.
- Return costs post to `portal_expenses` category **Returns** (refund + seller-paid label + unrecovered fees + re-grade loss).
- Relist disposition restores `available` and uses existing `sale_relist` / listing sync / double-sale protection.
- Return reserve only affects **new** Amazon list-price suggestions; stored `ask_cents` and live listings are untouched.
