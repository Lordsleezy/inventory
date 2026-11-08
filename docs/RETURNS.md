# Returns system (Floor)

Channel-agnostic returns for Amazon, TikTok Shop, website, eBay, Depop, and the rest (historical Mercari sales still label correctly).
Garage receiving lives under **Admin → Returns** (its own tab on desktop and on the phone).

## What you must do by hand

### Amazon (MFN returns report)

1. In Seller Central → Apps & Services → Develop Apps, open the Floor SP-API app.
2. Confirm the app has **Inventory and Order Tracking** (and **Direct to Consumer Shipping** if Amazon requires it for returns reports).
3. If Roles were just added, re-authorize the app so the refresh token picks up the new roles.
4. Keep existing Netlify env vars (`AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_REFRESH_TOKEN` / connections row, `AMAZON_SELLER_ID`).
5. Optional: `AMAZON_RETURNS_LOOKBACK_DAYS` (default 14, max 60).
6. After deploy, hit `POST https://inventoryobi.netlify.app/.netlify/functions/returns-sync` with `{"action":"status"}` then a plain POST to run once.
7. Confirm a test RMA appears under **Orders → Returns** and that `return_decision` email hits `obitracking@gmail.com` (Gmail SMTP / `FLOOR_OWNER_EMAIL`).

### TikTok Shop (US Custom app)

Full setup (redirect URL, Manage API scopes, env list): **[docs/TIKTOK_SHOP.md](./TIKTOK_SHOP.md)**.

1. Create a TikTok Shop Partner account and a US Custom app for Open Box Industries.
2. Request seller **order / product / return-refund** scopes; complete app review and shop authorization.
3. Register redirect: `https://inventoryobi.netlify.app/.netlify/functions/tiktok-oauth-callback`.
4. Set Netlify env: `TIKTOK_SHOP_APP_KEY`, `TIKTOK_SHOP_APP_SECRET`, `TIKTOK_SHOP_SHOP_ID` (optional `TIKTOK_SHOP_SERVICE_ID`).
5. Admin → Marketplaces → **Authorize TikTok Shop** (tokens land in `connections` provider=`tiktok`).
6. Redeploy Netlify. Status: `POST .../tiktok-returns-sync` with `{"action":"status"}`.
7. Decision clock defaults to **48 hours** (`return_settings.decision_hours.tiktok`); `ingest_channel_return` enqueues `return_decision` alerts.

### eBay (ikonikdeals2026)

Listings use the business policy **OBI Returns – 30 Day Buyer Pays**: returns accepted, 30 days, buyer pays return shipping. The desk follows the return reason. Nothing is refunded until an admin taps confirm.

Not as described, damaged, or the wrong item (eBay reason type SNAD): the refund is the item price plus the original shipping the buyer paid. The return label is on us. There is no deduction. See eBay's Money Back Guarantee and the Post-Order `RefundFeeTypeEnum` (`PURCHASE_PRICE` and `ORIGINAL_SHIPPING`).

Change of mind: the buyer pays return shipping. The refund is the item price, and original shipping stays out of it, which eBay allows when the seller offered returns and the buyer paid shipping. If the item comes back used or damaged, a deduction up to 50% is allowed after a condition note and a photo uploaded to eBay first.

1. Admin → Returns → **Check eBay**. That pulls Post-Order return requests into the same desk as Amazon and TikTok. Each row shows the reason.
2. Open an eBay return. The refund button shows the full amount for that reason. **Refund** sends it only after the tap.
3. A deduction is shown only on a change-of-mind return. Enter a percent (50 max), a condition note, and a photo, then **Submit deduction**.
4. Confirming voids the sale and posts only the extra costs: our return label on a not-as-described return, unrecovered fees, and the deduction we kept (that amount reduces the loss). A refund is not posted again as an expense. Commission already paid becomes a negative adjustment. A second tap is refused.

### Dropship bot branch

`feat/dropship-bot` was **not** on the remote when this shipped. Use:

- Table `suppliers` (+ `units.supplier_id`)
- RPC `supplier_return_policy_check(store_id, supplier_id)` before listing
- Admin **Settings → Returns → Dropship suppliers**

### Ops

1. Open **Settings → Returns**: reserve % (Amazon/TikTok default 10%), refund-without-return threshold.
2. Train garage flow: **Returns** → find the SKU or order → inspect → photo → disposition.
3. For Amazon/TikTok ship-outs: pack-time photo (serial optional) is required before **Mark shipped**.

### Shippo return tracking (inbound)

1. In [Shippo](https://goshippo.com/) → **Settings → API → Webhooks**, add endpoint  
   `https://inventoryobi.netlify.app/.netlify/functions/shippo-tracking-webhook`  
   and subscribe to **track_updated** (all carriers you use for returns: USPS, UPS, FedEx).
2. No extra env vars beyond the existing live **`SHIPPO_API_KEY`** (`shippo_live_…`).
3. Optional smoke test (admin bearer token):  
   `POST /.netlify/functions/return-track-sync` with `{"return_id":"<uuid>"}`  
   Poll fallback for open returns: same function with `{"action":"poll_open"}` (can be scheduled in Netlify).
4. Return detail in Admin refreshes the timeline from `return_tracking_events`; carrier scans also move status to **In transit** / **Received** automatically.

## Architecture notes

- Same SKU reopens on restock; never mint a new SKU for a returned unit.
- Refunded sales call `return_reverse_sale` → `sales.voided_at` so payouts/commission drop that sale (same as other voids). Buyer-keeps / write-off sets unit `lost`/`scrapped` without relist.
- Return costs post to `portal_expenses` category **Returns** (refund + seller-paid label + unrecovered fees + re-grade loss).
- Relist disposition restores `available` and uses existing `sale_relist` / listing sync / double-sale protection.
- Return reserve only affects **new** Amazon list-price suggestions; stored `ask_cents` and live listings are untouched.
