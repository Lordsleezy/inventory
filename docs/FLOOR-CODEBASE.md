# Floor codebase guide

What Floor is, how it's wired, and what enforces what. Written from reading the code at
`master` @ `e629479` (merge of PR #131, 2026-10-24). Everything here was checked against
the source. **Nothing here was checked against the live database** (this session had no
live DB access), so wherever the doc says "the database does X", it means "the migrations
in `supabase/migrations` say it does X". Places where code and live may differ are listed in
[FLOOR-PROBLEMS.md](./FLOOR-PROBLEMS.md).

Ranked problems: [FLOOR-PROBLEMS.md](./FLOOR-PROBLEMS.md). Older topic docs in this folder
(`CHANNELS.md`, `ONLINE-ORDERS.md`, `RETURNS.md`, `SQUARE.md`, `TIKTOK_SHOP.md`, …) go deeper on single
features, but several are older than the code. Where they disagree, this doc follows the code.

---

## 1. The 30-second version

```
           Browsers / phones                          Marketplaces & services
 ┌──────────────────────────────────┐        ┌──────────────────────────────────────┐
 │ apps/admin  (Vite/React PWA)     │        │ eBay · Amazon SP-API · TikTok Shop    │
 │  admin.openboxindustries.com     │        │ Square · Shippo · Veeqo · Gemini      │
 │  desktop portal + Register +     │        │ UPCitemdb · Census · Resend · Gmail   │
 │  phone "app mode"                │        │ Google Merchant                       │
 └──────┬──────────────┬────────────┘        └───────────────▲──────────────────────┘
        │ supabase-js  │ fetch /api/floor/<fn>                │ HTTPS (server-side only)
        │ (anon key +  │ (proxy to inventoryobi)              │
        │  user JWT)   ▼                                      │
        │      ┌─────────────────────────────────────────────┴──┐
        │      │ Netlify functions site: inventoryobi.netlify.app │
        │      │ netlify/functions/*.mjs (92)  + netlify/lib (149)│
        │      │ scheduled crons, background workers, webhooks   │
        │      └──────────────┬──────────────────────────────────┘
        │                     │ service-role supabase-js
        ▼                     ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ Supabase project "floor" (zoukmsmbztcuyoslvikp)                 │
 │ Postgres: units, sales, listings, web_orders, … ~114 tables      │
 │ ~410 SQL functions (portal_* RPCs are SECURITY DEFINER)          │
 │ RLS per store_id · pg_cron (reservations, delist nags)           │
 │ Storage: private photo buckets                                   │
 └───────────────▲────────────────────────────────────────────────┘
                 │ anon key, public views filtered by store_id
        Lordsleezy/openbox-store-web (public store site, separate repo)
```

* **Database is the source of truth** for inventory. A unit is one row in `public.units`
  (`store_id`, `sku`, `state`, `ask_cents`, `acquisition_cost_cents`, `listing_specs` jsonb, …).
* **Browsers never hold the service role.** The admin portal talks to Supabase as the signed-in
  user (RLS + `SECURITY DEFINER` `portal_*` RPCs) and to Netlify functions with its user JWT.
* **Netlify functions are the only place marketplace credentials live.** They use a service-role
  client (`netlify/lib/server.mjs` → `serviceClient()`) and do their own auth check first.
* **A sale anywhere ends in a Floor sale row** (`finalize_sale` / `finalize_ticket` /
  `marketplace_ingest_sale`), which flips the unit to `sold`, marks other `listings` rows delisted
  or opens `delist_tasks`, and queues alerts. Crons then end the listings on the API channels and
  a reconcile job catches anything missed.

## 2. Repo layout

| Path | What it is | Status |
|---|---|---|
| `apps/admin` | **The product.** Vite + React 18 + TS. Desktop admin portal, Register, phone "app mode" PWA (`src/appMode`). Netlify site config in `apps/admin/netlify.toml`. | Active |
| `netlify/functions` | 92 Netlify functions (HTTP, scheduled, `-background` long runners, webhooks). Root `netlify.toml` = **inventoryobi** site. | Active |
| `netlify/lib` | Shared server code: marketplace clients, sale ingest, pricing, shipping, mail, logging, auth. Most real logic lives here. | Active |
| `supabase/migrations` | 295 SQL migrations = the schema. See §6 for the recovered-ledger story. | Active |
| `supabase/unapplied-legacy-migrations` | 33 SQL files that never ran on live but are needed for a fresh replay. **Never batch-apply.** | Reference |
| `supabase/phase2-drafts` | One draft (`20261029040000_channel_categories.sql`), superseded by `20261030110017_channel_categories.sql`. | Dead |
| `supabase/tests` | pgTAP tests, `recovered-live-versions.txt`, photo-access tests. | Active |
| `packages/cloud` | `@floor/cloud`: shared Supabase client + staff session + sell helpers. **Used by admin** (`loadStaffSession`, `floorCloud`). | Active (shared) |
| `packages/store`, `packages/channels`, `packages/payments` | Pure TS domain helpers (SKU rules, channel pricing, tax/payments math) with unit tests. Used by admin/pos/tests. | Active (shared) |
| `apps/mobile` | Old Vite/React phone UI (wrapped by Capacitor). | Legacy |
| `apps/adapter` | Capacitor iOS/Android host for `apps/mobile`. | Legacy |
| `apps/pos` | Old Tauri desktop register (built as a `.deb` by `.github/workflows/pos-linux.yml`). Its tests still run in `npm test`. | Legacy |
| `apps/kiosk` | Android device-owner launcher for the store phone. | Legacy-ish (still referenced by unmerged PRs) |
| `legacy/` | Surface / InvenTree experiment. Not in npm workspaces. | Dead |
| `scripts/` | Deploy guard + deploy/rollback, migration replay tests, photo tools, one-off ops scripts. | Mixed |
| `docs/` | Feature docs (this file, problems list, older topic docs). | — |

Agent rules: `AGENTS.md` (migration + deploy rules, §10). There is **no** `CLAUDE.md` or `.cursor/rules`.
The root `README.md` is stale: it still describes the Capacitor iPhone app and migrations `0001`–`0009`.

## 3. How a request flows

### 3.1 Admin portal → Supabase (most screens)
1. `apps/admin/src/App.tsx` signs in with `@floor/cloud`'s Supabase client (anon key + user session).
2. On sign-in it loads, in parallel, `portal_admins` (`store_id` for this user) and `loadStaffSession()`
   (the `staff` row: `role` owner/manager/clerk, `store_id`).
3. **Full access** = has a `portal_admins` row **or** staff role `owner`/`manager`. Otherwise the user is an
   **associate** and only sees `register`, `inventory`, `settings` (`ASSOCIATE_PAGES` in `App.tsx`).
   This is a UI gate only — the real wall is in the database (§7).
4. Screens call `sb.rpc('portal_*', …)`. Those RPCs are `SECURITY DEFINER`, resolve the store with
   `portal_store_id()` / `current_store_id()`, and check `portal_is_admin()` where money is involved.

### 3.2 Admin portal → Netlify function
1. `floorFunctionUrl(name)` in `apps/admin/src/floorApi.ts`:
   on `admin.openboxindustries.com` → `/api/floor/<name>` (same-origin), else
   `VITE_FLOOR_FUNCTIONS_URL` or `https://inventoryobi.netlify.app/.netlify/functions/<name>`.
2. `apps/admin/netlify.toml` redirects `/api/floor/*` → `https://inventoryobi.netlify.app/.netlify/functions/:splat` (status 200 proxy).
3. The function reads `Authorization: Bearer <user JWT>` and authorizes with one of:
   * `portalAdminFromEvent` (`netlify/lib/portal-auth.mjs`) — user must have a `portal_admins` row; store comes
     from that row (any `store_id` hint in the body is ignored for real users). Also accepts the raw service-role
     key as a bearer for ops scripts (then the `store_id` hint is used).
   * `staffFromEvent` / `connectionAdminFromEvent` (`netlify/lib/server.mjs`) — staff row; owner/manager for
     connection management.
   * Shared-secret headers for machine callers: `x-store-web-key` (store website: `web-checkout`, `loyalty-web`,
     `rewards-quote`), `x-listing-feed-key` (`listing-feed`), `x-connections-key`, marketplace webhook signatures
     (`ebay-notify`, `tiktok-webhook`), `MARKETPLACE_EMAIL_SECRET` (`marketplace-email`).
4. The function then uses `serviceClient()` (service role) for DB work and calls the marketplace API.
5. Every function is wrapped by `netlify/lib/floor-log.mjs` (`wrapHandler` / `asNetlifyFunction`), which writes
   to the Jobs/Logs tables shown in the **Logs** screen.

### 3.3 Scheduled / background
* Netlify schedules call the function with a `{ next_run }` body (`isNetlifyScheduleEvent` in `netlify/lib/schedule.mjs`).
* Work longer than ~26 s is handed to a `*-background` function (15-min limit) via an internal POST
  authenticated with the service role, usually under a lock (`netlify/lib/bg-guard.mjs` `withLock`).

### 3.4 Public store website
`Lordsleezy/openbox-store-web` reads public views (`public_items`, `storefront_items`, `public_categories`, …)
with the anon key, filtered by `store_id`, and calls `web-checkout` / `loyalty-web` / `rewards-quote` with
`x-store-web-key`. Web orders land in `web_orders` and show up on the admin **Orders** screen.

## 4. Admin portal screens

Routing lives in `apps/admin/src/navigation.ts` (URL params `page`, `tab`, `inventoryTab`, `section`,
`onlineTab`, `channel`; old URLs are mapped through `LEGACY`). `App.tsx` renders the page. "fn" = Netlify
function (via `floorFunctionUrl`), "rpc" = Supabase RPC, "tbl" = direct table read under RLS.

| Page (`?page=`) | Component(s) | Data |
|---|---|---|
| `register` | `RegisterPage` → `register/cart`, `register/units`, `register/CustomerAttach`, `register/RegisterSettings`, `register/NativeRegister`, `kiosk` | tbl `units_pos`, `photos`; `@floor/cloud` `ticket.ts`: rpc `quote_ticket_totals`, `finalize_ticket`, `void_ticket`, `approve_with_pin`, `set_store_setting`; rpc `portal_bundle_for_sku`; Square card flows via `register/sale.ts` (fn `square-*`). Associates can use it. |
| `sales` | inline in `App.tsx` + `CommissionOverride` | rpc `portal_sales`, `portal_voided_sales`, `portal_unmatched_orders`, `portal_match_web_order`, `portal_payout_sales`, `portal_payout_config`, `portal_people`, `portal_set_commission_override` |
| `orders` | `OrdersPage` + `LabelDialog`, `ReturnsPage`, `CommissionOverride` | rpc `portal_web_orders`, `portal_mark_order_shipped`/`_delivered`, `mark_pickup_complete`, `portal_set_order_label_cost`, `portal_set_pack_condition`, `portal_set_pack_proof`, `portal_suggest_order_skus`, `portal_match_web_order`; returns rpcs (`portal_returns`, `portal_return_lookup`, `portal_inspect_return`, `portal_disposition_return`, `portal_set_return_status`); fn `web-order-admin` (labels, cancel/refund, ship) |
| `receipts` | `ReceiptsPage` | rpc `portal_receipts` |
| `inventory` | `InventoryPage` + `UnitEditDrawer` | rpc `portal_inventory_list_with_locations`, `portal_inventory_detail`, `portal_update_unit`, `delete_unit`, `portal_clear_ebay_review`, `portal_add_unit_photo`; tbl `store_locations` |
| ↳ `inventoryTab=in-stock / sold / defective` | `InventoryPage` list | same list RPC with filters |
| ↳ `unfinished` | `NeedsAttentionPanel` → `MissingFieldPage`, `MissingCostPage` (`section=missing-*`) | rpc `portal_units_missing_field`, `portal_units_missing_cost`, `portal_set_unit_cost`, `portal_set_unit_ask`, `portal_set_unit_text`, `portal_bulk_set_unit_text`, `portal_set_unit_aspect`, `portal_set_unit_shipping` |
| ↳ `missing-category` | `CategoryPanel` | rpc `portal_category_queue`, `portal_category_search`, `portal_category_attributes`, `portal_set_channel_categories`, `portal_identical_category_skus`, `portal_depop_category_save`; tbl `channel_taxonomy`, `store_category_mappings`, `store_depop_categories`; fn `category-confirm`, `category-fields` |
| ↳ `receive` | `ReceivePanel` (+ `BundleReceive`) | rpc `portal_receive_options`, `portal_receive_unit`, `portal_enrich_received_unit`, `portal_add_unit_photo`, `portal_tag_manifest`; fn `upc-lookup`, `receive-photo-identify`, `category-resolve` |
| ↳ `lookup-test` | `LookupTestPage` | fn `upc-lookup` |
| ↳ `products` | `FloorProductsPage` | rpc `portal_floor_products_search`, `portal_floor_product_upsert` |
| ↳ `measure-mat` | `MarkerMatPage` | client-only (camera measuring mat) |
| `online` | `OnlinePage` (`onlineTab` listed/ready/not-ready/msc/reports/sold × `channel`) | rpc `portal_online_board`, `portal_online_channel_counts`, `portal_online_report`, `portal_online_sold` |
| `marketplaces` | `ConnectionsPage` | fn `ebay-connection`, `amazon-list`, `tiktok-list`, `oauth-start`/`oauth-go`/`oauth-callback`, `square-connect-start`, `google-setup` (connection status/connect/disconnect) |
| `ebay`, `tiktok`, `depop` | `ChannelListingPage` → `MarketplaceBoard`, `ListingManagerPanel` (+ `TikTokShopPanel`, `EbayDraftsPage`) | fn `listing-manager` (list/add/edit/end/migrate/bulk; `listing-manager-background` for paced bulk), `ebay-drafts`, `tiktok-list`; rpc `portal_tiktok_list*` |
| `amazon` | `AmazonPage` | rpc `portal_amazon_list`, `portal_amazon_list_add`, `portal_amazon_list_remove`, `portal_amazon_set_upc`; fn `amazon-list` |
| `reports` `tab=profit` | inline `App.tsx` (profit/payout math in `payouts.ts`) | rpc `portal_sales` |
| ↳ `shipping` | `ChannelReportPage` | rpc `portal_channel_report`, `portal_channel_report_detail` |
| ↳ `expenses` | `ExpensesPage` / `TaxPage` | rpc `portal_add_expense`, `portal_update_expense`, `portal_delete_expense`; tbl `portal_expenses` |
| ↳ `overhead` | `OverheadPage` | rpc `portal_add/update/delete_overhead`; tbl `portal_overhead` |
| ↳ `payouts` | inline `App.tsx` + `payouts.ts` | rpc `portal_payout_sales`, `portal_payout_adjustments`, `portal_payout_config`, `portal_set_payout_config`; tbl `portal_payout_rules`, `portal_payout_payments`, `portal_commission_overrides` |
| ↳ `daily` | inline + `reportExport.ts` | tbl `portal_reports` (CSV download) |
| ↳ `sales-tax` | `TaxReportPage` | rpc `portal_tax_report`, `portal_sale_tax_rows` |
| ↳ `returns` | `ReturnsReportPanel` | rpc `portal_return_report` |
| `withdrawals` | `WithdrawalsPage` | rpc `portal_save_withdrawal`, `portal_void_withdrawal`, `portal_withdrawal_entries`, `portal_withdrawal_audit`, `portal_withdrawal_reconciliation`; tbl `staff` |
| `manifests` | `ManifestsPage` | rpc `portal_create_manifest`, `portal_manifest_list`, `portal_set_manifest_count`, `portal_tag_manifest` |
| `locations` | `LocationsPage` | rpc `portal_bay_list`, `portal_set_bay`, `portal_move_location_stock`; tbl `unit_location_stock` |
| `insights` | `InsightsPage` | rpc `portal_insights`, `portal_manifest_list`; tbl `census_ecommerce_quarters` |
| `logs` | `LogsPage` (+ `clientLog.tsx` reports browser errors) | fn `portal-logs` |
| `settings` | `SettingsPage` → `OnlineSellingPage`, `LedgerSettingsPanel`, `ReturnSettingsPanel`, `EligibilityPage`, `VideoScanBudget`; associates get `AssociateSettings` | rpc `portal_online_settings`, `portal_set_online_setting`, `portal_set_marketplace_packing_markup`, `portal_ship_carriers`, `portal_ledger_config` (+ fee-rate / cost-default / tax-remitted setters), `portal_return_settings`, `portal_suppliers`, eligibility/policy rpcs, `video_scan_budget`; fn `listing-check-background`, `web-order-admin` |
| `cameras`, `remote` | placeholder panels in `App.tsx` ("FUTURE INTEGRATION") | none |

Other components: `YourCallPanel` (rpc `portal_listing_queue*` — listing decisions), `ReviewMatchesPage`
(rpc `portal_review_matches`, fn `portal-match-action` — visual product-match review), `MarketplacePrices`
(rpc `portal_set_unit_marketplace_markup`), `UnitShippingPanel`, `EligibilityPage`.

**Phone "app mode"** (`apps/admin/src/appMode/*`, gated by `InstallGate`): `AppInventory`
(rpc `portal_inventory_list`), `AppItemDetail` (`portal_inventory_detail`), `AppReceive`, `AppOrders`
(`portal_web_orders`, `portal_floor_cancel_order`, ship/deliver/pickup, pack proof), `AppChannel`
(fn `listing-manager`), `AppMore` (`portal_sales`). Service worker: `apps/admin/public/sw.js`, registered in `main.tsx`.

## 5. Life of an item

### 5.1 Receive
1. **Inventory → Receive** (`ReceivePanel`) or phone `AppReceive`. Scan/type a UPC.
2. fn `upc-lookup` (`netlify/lib/upc-lookup.mjs`, portal admin only, read-only). Order of trust:
   Amazon SP-API Catalog + Pricing → UPCitemdb (fills gaps only) → optional eBay sold comps. Results are
   cached in `public.upc_lookup_cache` (keyed by GTIN-14, service-role only); a cache hit makes no external call.
3. **Barcode miss → photo fallback:** fn `receive-photo-identify` sends one photo to Gemini and returns an
   identification plus a price *median/range for the owner to choose from*. It never writes a price.
   (The phone video flow `video-scan-*` does the same with short clips + candidate photos.)
4. rpc `portal_receive_unit` (latest def `20261023230521_receive_sku_matches_next_sku.sql`) inserts the unit with
   the next SKU; `portal_enrich_received_unit` stores lookup data into `listing_specs`; `portal_add_unit_photo`
   uploads to the private photo bucket. `portal_tag_manifest` ties it to a purchase manifest.
   Price (`ask_cents`) and cost (`acquisition_cost_cents`) are typed by a person.
5. fn `category-resolve` suggests channel categories from the UPC cache / identical SKUs (explicit taxonomy, no
   runtime AI categories).

### 5.2 Categories
* Trigger `initialize_unit_categories` (`20261030110017_channel_categories.sql`) creates one
  `unit_channel_categories` row per channel for every new unit: **eBay enabled, Amazon enabled, TikTok disabled,
  Depop disabled**.
* `floor_category_gaps()` (`20261030110018_category_guards.sql`) lists problems for each *enabled* row: missing
  category, retired category, fields not synced, taxonomy older than 4 days, category changed, Amazon schema
  validation pending, missing required attribute.
* **Inventory → Missing category** (`CategoryPanel`, rpc `portal_category_queue`) shows in-stock units with any gap.
  Confirming writes through `portal_set_channel_categories` (also saves a per-store `store_category_mappings` row)
  and fn `category-confirm` / `category-fields`.
* Taxonomy itself (`channel_taxonomy`) is refreshed by `category-sync` (one channel per day, rotating eBay →
  TikTok → Amazon) → `category-sync-background`.
* Guards: `floor_category_pre_push` blocks a channel push with gaps; `floor_category_ready_guard` /
  `floor_category_demote_sku` pull units back out of Ready when categories break.

### 5.3 Ready to List
`portal_online_board` (`20261022074605_online_board_partition_counts.sql`) splits inventory into
Listed + Ready + Not ready + Facebook-only (= total). **Ready** = has photo, `ask_cents > 0`, cost known,
package specs, `show_on_website`, eBay eligibility `allow`, no blockers. Not-ready rows carry reasons
(Missing photo / price / cost / package specs, Hidden from website, eBay eligibility). "MSC" = Mercari/Depop/Whatnot
manual channels. The **Unfinished** inventory tab uses `unit_listing_gaps` / `portal_units_missing_field`.

### 5.4 Push to each channel
All pushes go through fn `listing-manager` → `netlify/lib/listing-manager.mjs` (portal admins only):
* **eBay:** `publishCreate` / `patchEbayListing` / `endEbayListing` / `relistEbayListing` via Inventory API
  (+ Trading API for revise). Two accounts: business selling account and personal orders-only account
  (`docs/EBAY_MULTI_ACCOUNT.md`, `ebay_accounts`). Bulk = `queueBulkPublish` → `listing-manager-background`.
  Extra eBay workers: `ebay-drafts` (+ `ebay-drafts-refresh(-background)`), `ebay-photo-day-list-background`,
  `ebay-free-ship-bump-background`, `ebay-pickup-list-background`, `ebay-migrate-*`, `ebay-spec-backfill-background`.
* **Amazon:** `AmazonPage` queue (`amazon_list_items`) → fn `amazon-list` (prepare / ASIN / price / list one) →
  SP-API Listings Items. Category validation in `netlify/lib/amazon-category-validation.mjs`.
* **TikTok Shop:** `TikTokShopPanel` queue (`tiktok_list_items`) → fn `tiktok-list` → `netlify/lib/tiktok-shop.mjs`.
* **Depop:** no API. `buildDepopPack` builds copy/photos; a person posts it and `confirmDepopListed` records it.
* **Google Merchant:** `google-sync` (every minute) pushes local-inventory offers; `google-reconcile` every 6 h.
* **Store website:** `show_on_website` → public views read by `openbox-store-web`.
* Channel price = owner's ask + markup/reserve/label math (`channelListCents` in `netlify/lib/channel-sync.mjs`,
  `netlify/lib/marketplace-pricing.mjs`). It is derived from the owner's ask; nothing invents an ask.
* Editing a unit later → `syncLiveChannels` (`channel-sync.mjs`) patches every live channel; Depop gets a
  `listing_specs.manual_updates.depop` flag instead.

### 5.5 Sale on any channel → delist everywhere
| Where it sold | How Floor learns | Entry point |
|---|---|---|
| Register (in store) | `finalize_ticket` (Register) / `finalize_sale` (older single-item path) from `@floor/cloud` | `packages/cloud/src/ticket.ts`, `sell.ts` |
| Store website | `web-checkout` (Square charge + reservation) → web order | `netlify/functions/web-checkout.mjs` |
| eBay | `ebay-sync` every 3 min (`pollAllStores` in `netlify/lib/ebay.mjs`) + `ebay-notify` webhook | `marketplace_ingest_sale` |
| Amazon | `amazon-sync` every 10 min | `marketplace_ingest_sale` |
| TikTok | `tiktok-orders-sync` every 10 min + `tiktok-webhook` | `marketplace_ingest_sale` |
| Depop / Mercari | `gmail-sales-poll` every 2 min reads sale emails (parser `netlify/lib/marketplace-email-parse.mjs`, Gemini for messy mail); `marketplace-email` webhook shares the code | `marketplace_ingest_sale` or `needs_review` |

DB side: `finalize_sale` (latest `20261002140000_phone_card_fee.sql`) sets `units.state='sold'`, calls
`open_delist_tasks` (`0006_stores.sql`) and writes `alert_outbox`. `marketplace_ingest_sale` (latest
`20261025140000_marketplace_order_dedupe.sql`) dedupes by order, records the sale, marks other `listings`
`delisted`, and creates `web_orders` + `channel_orders` rows (so the sale shows on **Orders**).

Then the delist actually happens:
* eBay: `ebay-sync` → `withdrawOpenEbayTasks` ends offers for open `delist_tasks`.
* Amazon: `amazon-sync` → `zeroAmazonQuantityForSku` (`netlify/lib/amazon.mjs`) sets qty 0 and closes the task.
* TikTok: `netlify/lib/tiktok-shop.mjs` deactivates the product.
* Depop / Whatnot / Mercari: `delist_tasks` stay open; pg_cron `enqueue_delist_nags` (every 5 min) nags until
  someone marks it done (**Marketplaces** screen, rpc `portal_complete_marketplace_delist`).
* Safety nets: `inventory-reconcile` (15 min: sold units still listed, sales that left a unit available, ends eBay,
  emails the owner), `marketplace-sale-watch` (sale emails with no order after 10 min), `dispatch-alerts`
  (double-sell and sale alerts by Gmail SMTP). pg_cron `release_expired_reservations` (every minute) frees
  abandoned holds.

### 5.6 Label / fulfilment
**Orders** screen → `LabelDialog` → fn `web-order-admin` → `netlify/lib/web-label.mjs` (`labelQuote`,
`buyLabelForOrder`, `voidLabel`). Rate sources: Shippo (`netlify/lib/shippo.mjs`), Veeqo
(`netlify/lib/shipping/veeqo.mjs`), Amazon Buy Shipping, TikTok shipping, combined in
`netlify/lib/shipping/quote-engine.mjs` / `sources.mjs`. Tracking is pushed back to the marketplace
(`shipping/marketplace-tracking.mjs`). Pickup orders: `mark_pickup_complete`; `web-pickup-sweep` reminds, expires
and refunds. Buyer "shipped" email: `web-order-email` (Resend).

### 5.7 Payout / ledger
* Sale ledger: `20261016093000_full_ledger.sql` (`portal_sales`, `sale_ledger` view, channel fee rates, cost
  defaults, tax remitted). `channel-fee-sync` (15 min) writes real eBay fees and eBay-bought label costs onto sales.
* Payouts are computed **in the browser** (`apps/admin/src/payouts.ts`, used by `App.tsx`): profit = merchandise
  revenue (+ buyer-paid shipping for commission) − `acquisition_cost_cents × qty`, before tax and card fees.
  Online Paul 30 %, in-store Paul 20 %, Jacob 10 %, per-sale overrides in `portal_commission_overrides`
  (`CommissionOverride.tsx`). Unknown cost blocks payout; cost is read from the *current* unit row.
* Paid amounts: `portal_payout_payments`, `portal_paid_payouts`; rules `portal_payout_rules`.

### 5.8 Return
* Intake: `returns-sync` (30 min, Amazon MFN returns report via `netlify/lib/amazon-returns.mjs`; TikTok part is a
  stub) and `tiktok-returns-sync` (30 min) → rpc `ingest_channel_return`
  (`20261021035223_returns_ingest_channel_return.sql`) → `return_decision` alerts (TikTok 48 h deadline).
* **Orders → Returns** (`ReturnsPage`): lookup, inspect, photos, then `portal_disposition_return`
  (`20261021040729_writeoff_channels_active_marketplaces.sql`): `relist` / `downgrade_channel` / `bundle_lot` put
  the unit back to `available`; `write_off` sets `scrapped` (unless restocked). Settings in `ReturnSettingsPanel`;
  reserve % per channel feeds channel pricing (`reservePctForChannel`).

### 5.9 Replacement and giveaway (units that leave without a sale)
Admin-only (`portal_is_admin()`; the clerk gets a 42501 from every RPC, and the buttons are hidden). Replacement / Given away
buttons sit on each in-stock unit (Inventory rows, and the phone-app item screen next to Sell). RPCs
(`20261031100000_replacements_giveaways.sql`): `portal_replacement_sale_search`, `portal_record_replacement`,
`portal_replacement_bad_unit_returned`, `portal_record_giveaway`, `portal_undo_disposition`, `portal_dispositions_list`,
`portal_unit_history`. Record table `unit_dispositions`; unit `state` becomes `replaced` / `given_away` (not in stock, not sold).
* Replacement: cost is read live from the replacement unit (+ extra cost). `sale_ledger.cost_cents` / `profit_cents` add it
  (`sale_cost_with_replacements`), so every report sees the lower profit. The frozen commission line is recomputed by
  `payout_sync_replacements`; a replacement unit with no cost makes that sale's commission wait (null). If the person was already
  paid past their other earnings, a negative `portal_payout_adjustments` row (`replacement_id`) is added; undo adds the opposite row.
* Giveaway: a `portal_expenses` row (source `giveaway`, category `Giveaways`) is kept in sync with the unit's live cost;
  no row while the cost is missing. Commissions are untouched.
* Both delist: open `delist_tasks` for every live listing, listings go `pending_delist`.

## 6. The database

### 6.1 Migrations and the recovered ledger
* `supabase/migrations` (295 files, `0001_init.sql` → `20261030110018_category_guards.sql`) is what `supabase db push`
  applies.
* On 2026-10-24 the migration history was rebuilt from the live ledger
  (`supabase/MIGRATION_RECOVERY_20261024.md`): 149 files are the exact SQL the live ledger recorded
  (`supabase/tests/recovered-live-versions.txt`). 33 older repo files that never ran on live were moved to
  `supabase/unapplied-legacy-migrations` — they exist only so a *fresh* database can be replayed (live SQL can't
  replay from zero, e.g. `20261009202042` uses a column added by `20261016093000`).
* Many functions were redefined many times; only the last file wins (e.g. `portal_web_orders` 17×,
  `portal_channel_report_detail` 15×, `portal_channel_report` 14×, `receive_unit`/`portal_receive_unit` 8×,
  `portal_sales` 7×, `finalize_sale`/`finalize_ticket` 6×). To read the current version, grep for the newest file.

### 6.2 Main tables (by area)
* **Tenancy / people:** `stores`, `staff` (role owner/manager/clerk), `portal_admins` (user → store, full portal),
  `store_settings` (key/value per store), `connections` (encrypted marketplace tokens per store/provider),
  `ebay_accounts`, `square_connections`.
* **Inventory:** `units` (one row per unit/SKU), `photos`, `lots` / `listing_lot_members`, `floor_bundles`,
  `store_locations` / `unit_location_stock`, `store_manifests`, `sku_ledger`, `floor_products`,
  `upc_lookup_cache`, `manufacturer_photos`.
* **Categories:** `channel_taxonomy`, `unit_channel_categories`, `store_category_mappings`, `store_depop_categories`.
* **Listings:** `listings` (sku × channel, status listed/delisted), `amazon_list_items`, `tiktok_list_items`,
  `delist_tasks`, `listing_checks`, eligibility / policy tables.
* **Sales:** `sales`, `tickets` (+ lines), `reservations`, `web_orders`, `channel_orders`,
  `marketplace_email_sales`, `customers` + loyalty tables.
* **Money:** `portal_expenses`, `portal_overhead`, `portal_payout_rules`, `portal_payout_payments`,
  `portal_paid_payouts`, `portal_commission_overrides`, `portal_reports`, `store_withdrawals`, channel fee rates.
* **Returns:** returns tables + `suppliers`.
* **Ops:** `alert_outbox`, job/log tables used by `floor-log.mjs`, `video_scan_*`, `census_ecommerce_quarters`.
* **Public views:** `public_items`, `storefront_items`, `public_categories` (store website), `units_pos` (Register),
  `sale_receipts`, `connection_status`, `square_connection_status`, `ebay_account_status`, `report_*`.

### 6.3 Key RPCs
`portal_*` = admin portal (SECURITY DEFINER, store from `portal_store_id()`/`current_store_id()`).
Selling: `quote_ticket_totals`, `finalize_ticket`, `void_ticket`, `approve_with_pin`, `reserve_unit`,
`release_reservation`, `finalize_sale`, `marketplace_ingest_sale`, `mark_pickup_complete`.
Inventory: `portal_receive_unit`, `receive_unit`, `portal_update_unit`, `delete_unit`, `portal_inventory_list`,
`portal_inventory_detail`, `portal_units_missing_field`, `portal_units_missing_cost`.
Online: `portal_online_board`, `portal_category_queue`, `floor_category_gaps`, `floor_category_pre_push`.
Money: `portal_sales`, `portal_payout_sales`, `portal_channel_report(_detail)`, `portal_tax_report`.
Returns: `ingest_channel_return`, `portal_disposition_return`.

## 7. Roles, RLS and what enforces what

| Rule | Enforced by |
|---|---|
| Store isolation | RLS on every table (`store_id = portal_store_id()` / `is_store_staff(store_id)` / `current_store_id()`); SECURITY DEFINER RPCs resolve the caller's store themselves |
| Admin vs clerk | `portal_is_admin()` (`20261030020000_inventory_subtabs_not_for_sale.sql`) = has `portal_admins` row **or** active staff `owner`/`manager` |
| Clerk (Jacob) never sees cost or sold prices | `portal_inventory_list` / `portal_inventory_detail` null out cost + sold price for non-admins; `sales` SELECT policy `portal_admin_sales` = admin only; `units` SELECT policy `manager_units` (`0007_authz.sql`) = managers only; old inventory RPCs revoked to service role. Clerks ring sales through SECURITY DEFINER RPCs. (See problem list: `units_pos` still shows `ask_cents` of sold units.) |
| Associate page set | UI only: `ASSOCIATE_PAGES` in `App.tsx` |
| Function access | `portalAdminFromEvent` / `staffFromEvent` / shared-secret headers (§3.2) |
| Prices are human | No code path writes `ask_cents` from AI: `receive-photo-identify` and `upc-lookup` only return suggestions; `portal_set_unit_ask` is called from the UI |
| Double-sale protection | `units.state` + reservations + `marketplace_ingest_sale` dedupe + delist tasks + reconcile crons |
| Photos private | Private bucket + signed URLs (`supabase/tests/photo-access.sql`, `scripts/test-photo-rls.mjs`) |

## 8. Scheduled and background jobs

| Function | Cadence | What it does |
|---|---|---|
| `ebay-migrate-dispatch` | every 1 min | Claims queued eBay migration / pickup-list requests, starts background workers |
| `google-sync` | every 1 min | Push local inventory to Google Merchant |
| `gmail-sales-poll` | every 2 min | Read Depop/Mercari sale mail → `marketplace_ingest_sale` |
| `enrich-models` | every 2 min (inline config) | Model/product enrichment for received units |
| `ebay-sync` | every 3 min | Ingest eBay orders, end eBay listings sold elsewhere, stall alert |
| `dispatch-alerts` | every 5 min | Drain `alert_outbox` (Gmail SMTP; APNS) |
| `loyalty-email` | every 5 min | Loyalty welcome/points/campaign emails |
| `web-order-email` | every 5 min | Buyer emails for web orders (Resend) |
| `web-order-reconcile` | every 5 min | Reconcile web orders vs payments |
| `marketplace-sale-watch` | every 5 min | Alert on sale emails with no order after 10 min |
| `amazon-sync` | every 10 min | Amazon orders + finances + zero qty for sold-elsewhere |
| `tiktok-orders-sync` | every 10 min | TikTok orders → Floor sale → delist elsewhere |
| `web-pickup-sweep` | every 10 min | Pickup reminders, expire + refund |
| `inventory-reconcile` | every 15 min | Safety net for missed sales/delists |
| `channel-fee-sync` | every 15 min | Real eBay fees/labels onto sales |
| `returns-sync` | every 30 min | Amazon returns report (+ TikTok stub) |
| `tiktok-returns-sync` | every 30 min | TikTok returns |
| `google-reconcile` | every 6 h | Google Merchant reconcile |
| `category-sync` | daily 10:00 UTC | Refresh one channel's taxonomy (rotates eBay/TikTok/Amazon) |
| `listing-check` | daily 14:00 UTC | Hand-off to `listing-check-background` (listing health) |
| `marketplace-daily-report` | daily 16:00 UTC | Daily marketplace email report |
| `census-seasonality-sync` | monthly, 1st 08:00 UTC | Census MRTS e-commerce data |
| pg_cron `floor-release-expired-reservations` | every 1 min | `release_expired_reservations()` |
| pg_cron `floor-delist-nags` | every 5 min | `enqueue_delist_nags()` |

Schedules live in root `netlify.toml` (+ inline `config` in `enrich-models`); `scripts/function-manifest.json`
must match (the deploy guard checks). On-demand background workers (`*-background`): category backfill/sync,
ebay drafts refresh, free-ship bump, listing audit, migrate, photo-day list, pickup list, push, spec backfill,
sync-now, listing-check, listing-manager, video-scan, video-scan-enrich. `ebay-drafts-refresh` is **not** scheduled
(see problems).

## 9. External integrations (env var names only)

| Service | What it does | Code | Env vars |
|---|---|---|---|
| eBay | Orders, listings (Inventory + Trading APIs), notifications, account deletion, finances | `netlify/lib/ebay*.mjs`, `functions/ebay-*.mjs`, `oauth-*.mjs`, `listing-manager.mjs` | `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME`, `EBAY_ENV`, `EBAY_MARKETPLACE_ID`, `EBAY_NOTIFICATION_TOKEN`, `EBAY_NOTIFICATION_ENDPOINT`, `EBAY_DELETION_*`, `EBAY_REQUIRED_USERNAME`, `EBAY_LOCATION_*`, `EBAY_ORDERS_ONLY`, `EBAY_DISABLED`, `EBAY_ORDERS_LOOKBACK_DAYS`, `EBAY_BACKFILL_BATCH`, `EBAY_QUOTE_BATCH`, `EBAY_BACKGROUND_WORK`, `EBAY_LOGISTICS_ENABLED`, `OAUTH_REDIRECT_URI` |
| Amazon SP-API | Catalog/pricing lookup, listings, orders, finances, returns report, Buy Shipping | `netlify/lib/amazon*.mjs`, `functions/amazon-*.mjs`, `lib/shipping/amazon-shipping.mjs` | `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_REFRESH_TOKEN`, `AMAZON_SELLER_ID`, `AMAZON_MARKETPLACE_ID`, `AMAZON_ACCOUNT_TYPE`, `AMAZON_SPAPI_SANDBOX`, `AMAZON_LISTING_ENABLED`, `AMAZON_SHIPPING_ENABLED`, `AMAZON_GATED_BRANDS`, `AMAZON_ORDERS_LOOKBACK_DAYS`, `AMAZON_RETURNS_LOOKBACK_DAYS`, `AMAZON_DOUBLE_SELL_EMAIL` |
| TikTok Shop | Listings, orders, returns, webhook, shipping | `netlify/lib/tiktok-shop.mjs`, `functions/tiktok-*.mjs`, `lib/shipping/tiktok-shipping.mjs` | `TIKTOK_SHOP_APP_KEY`, `TIKTOK_SHOP_APP_SECRET`, `TIKTOK_SHOP_ACCESS_TOKEN`, `TIKTOK_SHOP_SHOP_ID`, `TIKTOK_SHOP_SHOP_CIPHER`, `TIKTOK_SHOP_WAREHOUSE_ID`, `TIKTOK_SHOP_SERVICE_ID`, `TIKTOK_SHOP_API_BASE`, `TIKTOK_SHOP_AUTH_BASE`, `TIKTOK_SHOP_REDIRECT_URL`, `TIKTOK_SHOP_LISTING_ENABLED`, `TIKTOK_SHOP_FEE_PCT`, `TIKTOK_ORDERS_LOOKBACK_DAYS`, `TIKTOK_RETURNS_LOOKBACK_DAYS` |
| Depop / Mercari (email) | Sale detection from Gmail; Depop delist reminders | `functions/gmail-sales-poll.mjs`, `functions/marketplace-email.mjs`, `lib/marketplace-email-parse.mjs`, `lib/depop-email-match.mjs`, `lib/gmail-poll-plan.mjs` | `GMAIL_SMTP_USER`, `GMAIL_SMTP_APP_PASSWORD`, `GMAIL_POLL_EXTRA_USER`, `GMAIL_POLL_EXTRA_APP_PASSWORD`, `GMAIL_POLL_SENDERS`, `GMAIL_POLL_LOOKBACK_DAYS`, `GMAIL_POLL_INCLUDE_SEEN`, `MARKETPLACE_EMAIL_SECRET`, `GEMINI_*` |
| Square | Register card payments (Terminal + phone Mobile Payments SDK), OAuth per store, refunds; website checkout | `functions/square-*.mjs`, `functions/web-checkout.mjs`, `lib/web-payment.mjs`, `register/sale.ts` | `SQUARE_APPLICATION_ID`, `SQUARE_APPLICATION_SECRET`, `SQUARE_REDIRECT_URL`, `SQUARE_ENV`/`SQUARE_ENVIRONMENT`, `SQUARE_SANDBOX_ACCESS_TOKEN`, `SQUARE_SANDBOX_LOCATION_ID`, `SQUARE_WEB_ENV`, `SQUARE_WEB_ACCESS_TOKEN`, `SQUARE_WEB_APPLICATION_ID`, `SQUARE_WEB_LOCATION_ID`, `SQUARE_WEB_STORE_ID`, `SQUARE_WEB_SANDBOX_*`, `APP_DEEP_LINK_SETTINGS` |
| Shippo | Label rates/purchase for web + marketplace orders; eBay draft label quotes | `lib/shippo.mjs`, `lib/web-label.mjs` | `SHIPPO_API_KEY`, `SHIPPO_PLAN_NOTE` |
| Veeqo | Alternate label/rate source | `lib/shipping/veeqo.mjs`, `quote-engine.mjs`, `sources.mjs` | `VEEQO_API_KEY` |
| Gemini | Photo/video identify, retail lookup, email parsing, catalog photo | `lib/video-scan.mjs`, `functions/receive-photo-identify.mjs`, `lib/marketplace-email-parse.mjs`, `lib/ebay-catalog-photo.mjs` | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_RECEIVE_MODEL`, `GEMINI_RETAIL_MODEL`, `GEMINI_VIDEO_MODEL`, `GEMINI_INPUT_USD_PER_M`, `GEMINI_OUTPUT_USD_PER_M` |
| UPCitemdb | UPC gap-fill, dimensions, price refs | `lib/upc-lookup.mjs`, `lib/receive-price.mjs`, `lib/receive-dimensions.mjs`, `lib/floor-products.mjs` | `UPCITEMDB_KEY` (trial endpoint if absent) |
| Census | Monthly retail e-commerce seasonality (public MRTS file) | `lib/census-seasonality.mjs`, `functions/census-seasonality-sync.mjs` | none |
| Resend | Buyer emails (web order shipped, receipts) | `lib/mail.mjs`, `lib/web-order-email.mjs`, `lib/receipt.mjs`, `functions/email-receipt.mjs` | `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_REPLY_TO` |
| Google Merchant | Local inventory feed | `lib/google-merchant.mjs`, `functions/google-*.mjs` | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_MERCHANT_ACCOUNT_ID`, `GOOGLE_DATA_SOURCE_ID`, `GOOGLE_STORE_CODE`, `GOOGLE_MERCHANT_ENABLED`, `GOOGLE_MERCHANT_SETUP_KEY` |
| Supabase / core | DB, auth, storage; shared secrets | `lib/server.mjs`, `lib/portal-auth.mjs` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `SUPABASE_ANON_KEY`, `CONNECTIONS_KEY` (also token encryption), `LISTING_FEED_KEY`, `STORE_WEB_KEY`, `STORE_WEB_REWARDS_KEY`, `FLOOR_OWNER_EMAIL`, `ADMIN_PORTAL_URL`, `ALERT_WEBHOOK_SECRET`, `APNS_KEY_P8`; admin build: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_FLOOR_FUNCTIONS_URL` |

## 10. Deploy and migration rules

**Production** publishes from the `release` branch once a day at 6:00 Pacific, or when Paul runs the Release now workflow. Merging to `master` does not deploy and does not migrate live. See `AGENTS.md`.

**Functions site (inventoryobi)** — `scripts/DEPLOY.md`. Manual `scripts/deploy-prod-netlify.mjs` is emergency-only and stays behind `FLOOR_EMERGENCY_DEPLOY=yes-paul-approved`. It runs the deploy guard `scripts/lib/deploy-guard.mjs`, builds, and checks env var *names*. `--confirm-prod` publishes. Rollback of a single Netlify deploy: `scripts/rollback-prod-netlify.mjs` (same emergency flag). The normal rollback is the Roll back release workflow.
3. The guard fails on: a function missing from `scripts/function-manifest.json` (or vice versa), schedule
   mismatch, missing critical functions, legacy `export const handler`, oversized/missing artifacts, missing
   required env names. Regenerate the manifest with `scripts/write-function-manifest.mjs`.

**Admin site** — separate Netlify site built from `apps/admin/netlify.toml` (`npm run build -w @floor/admin`,
publish `apps/admin/dist`, Node 22). Build needs `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.

**Migrations** — `AGENTS.md`:
* Agents never apply migrations to live. The release job applies pending files from `master` before it fast-forwards `release`.
* Never `supabase migration repair --status reverted` to hide drift.
* Never batch-apply `supabase/unapplied-legacy-migrations`.

## 11. Multi-tenant boundaries

**Already per-store:** RLS on `store_id`; `store_settings` (tax, card fee, markup, online settings);
`connections` (encrypted tokens per store); `square_connections`; `store_category_mappings`;
`store_depop_categories`; return settings; `amazon-sync` / `tiktok-orders-sync` loop over every connected store.

**Hardcoded to Open Box Industries** (would break or leak for a second store) — details and paths in
[FLOOR-PROBLEMS.md](./FLOOR-PROBLEMS.md):
* Store UUID `5487ca47-6147-4fe8-bc6d-46b6472726ba` as `STORE_DEFAULT` / `STORE_ID` in 8 files; used for every
  TikTok webhook, scheduled `category-sync`, `returns-sync`, TikTok token refresh, eBay stall monitor.
* Marketplace credentials and ship-from data in **env vars** (one set per Netlify site): Amazon refresh token /
  seller id, TikTok access token / shop / warehouse, eBay required username + location, Square web checkout
  token + store id, Google Merchant account, Gmail inbox.
* Payout people + rates in `apps/admin/src/payouts.ts` (Jacob/Paul user UUIDs, per-SKU overrides).
* Store identity strings: eBay usernames `ikonikdeals2026` / `pgg124-5`, owner email fallbacks, "Open Box
  Industries" / Penryn address in label, listing, email, receipt and report code.
* Domains: `admin.openboxindustries.com`, `inventoryobi.netlify.app` in code and OAuth callbacks.
* Time zone `America/Los_Angeles` assumed in reports/crons.

## 12. Tests and checks
* `npm test` — node test runner over `packages/*`, `apps/pos`, payouts/ledger scripts and 2 of the 54
  `netlify/lib/*.test.mjs` files. (133 tests passed on this commit.)
* `npm run test:migrations` — PGlite replay (see problems: it skips the recovered live files).
* `npm run test:ticket-tax`, pgTAP in `supabase/tests/pgtap`, `scripts/test-deploy-guard.mjs`.
* CI: `.github/workflows/sql-tests.yml` (PRs to master), `pos-linux.yml` (legacy Tauri build), `release.yml`.
* Admin type-check: `cd apps/admin && npx tsc --noEmit` (clean on this commit).
