# Problems I found (ranked worst first)

From reading `master` @ `e629479` on 2026-10-24. **Nothing was fixed.** Nothing was checked against the live
database (no live access this session), so every database item says what the *migrations* show and what to
verify live before acting. "Severity" is my judgement: **High** = can lose money/data or leak data now, or blocks
selling Floor to a second store; **Medium** = wrong behaviour or real risk with a workaround; **Low** = cleanup.

Companion doc: [FLOOR-CODEBASE.md](./FLOOR-CODEBASE.md).

---

## High

### 1. CI never replays the SQL that is actually on live
* `scripts/lib/replay-migrations.mjs` builds the replay list from `supabase/migrations` **minus** every version
  in `supabase/tests/recovered-live-versions.txt` (the 149 files reconstructed from the live ledger) and **plus**
  `supabase/unapplied-legacy-migrations` (SQL that never ran on live).
* So `npm run test:migrations` (and `.github/workflows/sql-tests.yml`) tests a schema history that live never had.
  A new migration that breaks against the real live functions/tables can still pass CI.
* `scripts/test-migrations.mjs` also still prints `fresh 0001→0014 ok`, which hides what it ran.
* Verify: compare `supabase migration list` on live vs repo; consider a schema-dump diff instead of replay.

### 2. `manufacturer_photos` has no RLS in any migration
* Created in `supabase/migrations/20260924045329_public_items_shippable.sql` with no `enable row level security`,
  no `revoke`, no policy anywhere in `supabase/migrations`. Supabase's default grants give `anon` and
  `authenticated` full table privileges on new `public` tables, so unless live differs, anyone with the public
  anon key (it ships in the store website) could insert/update/delete manufacturer photo rows. Those rows feed
  `public_items.manufacturer_photos` on the public website.
* It is also not store-scoped (keyed by brand/model), so one tenant's rows show for all tenants.
* Verify live: `select relrowsecurity from pg_class where relname='manufacturer_photos'` and
  `\dp public.manufacturer_photos`.

### 3. Clerks can still see the asking price of sold units through `units_pos`
* `units_pos` (`supabase/migrations/20260924045253_web_shipping_units_pos.sql`) is `security_invoker = false`
  (runs as owner, bypasses `units` RLS), is granted to `authenticated`, filters only by `current_store_id()`, and
  returns `ask_cents` and `msrp_cents` for **every** state including `sold`.
* The intended rule (and `20261030020000_inventory_subtabs_not_for_sale.sql`) is "Jacob never gets money on sold
  units or any cost". Cost is not in the view (good), but the sold unit's ask price is. Usually ask = sold price
  for in-store sales.
* Related: I did not audit every `portal_*` RPC granted to `authenticated` for a `portal_is_admin()` /
  `portal_store_id()` check. Worth doing before trusting the "clerks can't see money" rule end to end.
* Verify live: sign in as a clerk and `select sku, state, ask_cents from units_pos where state='sold' limit 5`.

### 4. Multi-tenant blocker: store UUID hardcoded in server code
`5487ca47-6147-4fe8-bc6d-46b6472726ba` is hardcoded as `STORE_DEFAULT` / `STORE_ID` in:
`netlify/lib/tiktok-shop.mjs:38`, `netlify/lib/amazon.mjs:17`, `netlify/lib/returns.mjs:7`,
`netlify/lib/ebay-photo-day-list.mjs:35`, `netlify/lib/ebay-listing-audit.mjs:23`,
`netlify/lib/ebay-free-ship-bump.mjs:20`, `netlify/lib/ebay-sync-now.mjs:10`, `netlify/functions/ebay-sync.mjs:11`.
Where it actually breaks a second store:
* `netlify/functions/tiktok-webhook.mjs:76` — **every** TikTok webhook is attributed to store 1.
* `netlify/functions/tiktok-orders-sync.mjs:34` — token refresh runs only for store 1 (other stores' TikTok
  tokens expire).
* `netlify/functions/category-sync.mjs:11` — the scheduled taxonomy refresh runs only for store 1.
* `netlify/functions/returns-sync.mjs:38`, `tiktok-returns-sync.mjs:53` — scheduled returns intake only store 1.
* `netlify/functions/ebay-sync.mjs:73-105` — stall monitor / sync-completed bookkeeping only for store 1.
* `runAmazonSyncJob` / `runTikTokOrdersSyncJob` correctly loop over connected stores but fall back to store 1.
* For real users `portalAdminFromEvent` ignores the hint and uses their own store, so the `body.store_id ||
  STORE_DEFAULT` fallbacks in `listing-manager.mjs`, `tiktok-list.mjs`, `category-backfill*.mjs` only matter for
  service-role ops calls.

### 5. Multi-tenant blocker: one store's marketplace identity lives in Netlify env vars
One functions site = one set of: `AMAZON_REFRESH_TOKEN`, `AMAZON_SELLER_ID`, `TIKTOK_SHOP_ACCESS_TOKEN`,
`TIKTOK_SHOP_SHOP_ID`, `TIKTOK_SHOP_SHOP_CIPHER`, `TIKTOK_SHOP_WAREHOUSE_ID`, `EBAY_REQUIRED_USERNAME`,
`EBAY_LOCATION_*` (ship-from), `SQUARE_WEB_ACCESS_TOKEN` / `SQUARE_WEB_LOCATION_ID` / `SQUARE_WEB_STORE_ID`
(website checkout), `GOOGLE_MERCHANT_ACCOUNT_ID` / `GOOGLE_REFRESH_TOKEN` / `GOOGLE_STORE_CODE`,
`GMAIL_SMTP_USER` / `GMAIL_POLL_*` (the inbox that sale emails are read from), `FLOOR_OWNER_EMAIL`.
Some are "bootstrap fallback until a `connections` row exists" (`netlify/lib/amazon.mjs` `ensureAmazonRefreshStored`),
others are the only source (Square web, Google, Gmail, eBay location). Each needs to move to per-store
`connections` / `store_settings`.

### 6. Payout rules are hardcoded in the browser
* `apps/admin/src/payouts.ts:45-46` hardcodes Jacob's and Paul's user UUIDs; `:48` `IN_STORE_SKU_PROFIT_OVERRIDES`
  hardcodes per-SKU rates. Used by `App.tsx:1061` and `CommissionOverride.tsx:71`.
* Payout amounts are computed client-side (`payouts.ts` + `App.tsx`), not by a DB function, so two browsers on
  different builds can show different payouts, and nothing stores the computed number at sale time.
* Per `apps/admin/README.md`, cost is read from the *current* unit row, so editing a unit's cost later silently
  changes past payouts; sales without `actor_id` can't be assigned.
* For a second store none of this works (people/rates are not per store).

## Medium

### 7. Missing-category queue is inflated by default-enabled Amazon rows and a 4-day staleness rule
* `initialize_unit_categories` (`20261030110017_channel_categories.sql`) enables an **Amazon** row for every new
  unit (TikTok/Depop are off). `floor_category_gaps` (`20261030110018_category_guards.sql`) reports every enabled
  row with no category, and every Amazon row as "Amazon schema validation pending" until validated, so units
  that will never go to Amazon still sit in **Inventory → Missing category**.
* `floor_category_gaps` flags "category taxonomy stale" when `channel_taxonomy` is older than 4 days, while
  `category-sync` refreshes one channel per day in a 3-day rotation (`netlify/functions/category-sync.mjs:12`).
  One failed run makes a whole channel stale for everyone and floods the queue.
* `portal_category_queue` runs `floor_category_gaps` per unit (lateral) on every load — slow as inventory grows.

### 8. `ebay-drafts-refresh` says it is scheduled, but it isn't
`netlify/functions/ebay-drafts-refresh.mjs` header: "Scheduled every 15 minutes (netlify.toml)". It is not in
`netlify.toml` and has no inline schedule; `scripts/function-manifest.json` lists it without a schedule. The
`ebay-sync.mjs` header says draft refresh, label quotes, repricing, category refresh, reconciliation and spec
backfill "live in ebay-drafts-refresh" — so those only run when someone triggers them. Confirm intent.

### 9. Unmerged PR branches overlap each other and master
None of these are ancestors of `master` (checked with `git merge-base --is-ancestor`; open/closed state on
GitHub not checked):
* **#110** (store-phone keyboard / PWA reload), **#111** (#110 + Inventory Stats), **#115** (Android Gboard IME),
  **#117** (#115 + eBay ready-list runner) all edit `apps/admin/src/kiosk.ts` and `apps/admin/src/main.tsx`
  (and #115/#117 `ReceivePanel.tsx`, `StoreNumPad`) — they will conflict with each other.
* **#111** adds `supabase/migrations/20261029120000_portal_inventory_stats.sql`, but live already has
  `20261024015415_portal_inventory_stats.sql` — applying it would redefine a live function from a branch.
* **#82** (Withdrawals) is superseded by the merged `store_withdrawals` work (`20261022084348`).
* **#112** (AppMore live sales totals) and **#113** (MarketplaceBoard Ready-to-list tab) touch screens that have
  changed since.

### 10. Most backend tests don't run in CI
`npm test` (root `package.json`) runs only `netlify/lib/returns.test.mjs` and
`netlify/lib/amazon-category-validation.test.mjs` out of 54 `netlify/lib/**/*.test.mjs` files (eBay, labels,
payments, email parsing, video scan, deploy guard…). They can rot unnoticed.

### 11. Many SQL functions have 6–17 definitions; reading the wrong file is easy
`portal_web_orders` (17), `portal_channel_report_detail` (15), `portal_channel_report` (14), `receive_unit` /
`portal_receive_unit` (8), `portal_sales` (7), `finalize_sale` / `finalize_ticket` (6),
`marketplace_ingest_sale` (5). Only the newest file is live (if the ledger is right). Any agent editing one must
start from the newest definition or it will silently revert later fixes.

### 12. Hardcoded store identity strings
* Owner email fallback `pgg124@gmail.com`: `netlify/lib/amazon.mjs`, `netlify/lib/receipt.mjs`,
  `netlify/lib/ebay-listing-audit.mjs`, `netlify/functions/inventory-reconcile.mjs`, `google-setup.mjs`,
  `marketplace-daily-report.mjs`, `ebay-sync.mjs`, `marketplace-sale-watch.mjs`.
* eBay usernames `ikonikdeals2026` / `pgg124-5`: 36 references across `netlify/lib` + `netlify/functions`
  (e.g. `oauth-callback.mjs`, `ebay-connection.mjs`, `ebay-listing-audit*.mjs`).
* "Open Box Industries" / Penryn address: `netlify/lib/shippo.mjs`, `shipping/veeqo.mjs`, `shipping/quote-engine.mjs`,
  `web-payment.mjs`, `web-order-email.mjs`, `ebay.mjs`, `ebay-trading.mjs`, `ebay-drafts.mjs`, `amazon-create.mjs`,
  `listing-check.mjs`, `ebay-migrate.mjs`, `ebay-pickup-list.mjs`, `ebay-store-categories.mjs`,
  `ebay-photo-day-list.mjs`, `ebay-listing-audit.mjs`, `functions/google-setup.mjs`, `functions/loyalty-email.mjs`,
  `apps/admin/src/ReceiptsPage.tsx`, `MarketplaceBoard.tsx`, `register/sale.ts`, `register/RegisterSettings.tsx`,
  `reportExport.ts`.
* Domains `admin.openboxindustries.com` (`apps/admin/src/floorApi.ts`, `apps/admin/netlify.toml`) and
  `inventoryobi.netlify.app` (OAuth callbacks, `floorApi.ts`).

### 13. Service-role key accepted as a bearer token by admin functions
`netlify/lib/portal-auth.mjs:17` treats `Authorization: Bearer <SUPABASE_SERVICE_ROLE>` as an ops caller and trusts
the body's `store_id`. Reasonable for scripts, but it means the service-role key is also an HTTP credential for
every `portalAdminFromEvent` function (listing, ending, migrating listings). Background workers use the same
pattern (`ebay-pickup-list-background`, `ebay-migrate-background`). Combined with `Access-Control-Allow-Origin: *`
(`netlify/lib/server.mjs:18`) there is no origin restriction either. Low likelihood, high blast radius.

## Low

### 14. Overhead report tab can't be bookmarked
`apps/admin/src/navigation.ts:171` — `reportTabs` omits `'overhead'` (it's in the `ReportTab` type at `:22`), so
`?page=reports&tab=overhead` reloads to Profit.

### 15. Old deep links land on the wrong screen
`apps/admin/src/navigation.ts:49-74` maps legacy `reviews`, `review`, `your-call`, `missing-other` to
`section: 'missing-cost'`. Probably a deliberate collapse, but "Your call" links now open Missing cost.

### 16. Stale docs
* Root `README.md` describes the Capacitor iPhone app and migrations `0001`–`0009`.
* `supabase/phase2-drafts/README.md` says the channel-categories draft is not applied; its replacement
  `20261030110017_channel_categories.sql` is in `migrations`, so the draft is dead.
* Several `docs/*.md` topic docs predate later rewrites (check before trusting).

### 17. Legacy apps still built and tested
`apps/pos` tests run in `npm test`; `.github/workflows/pos-linux.yml` still builds the Tauri `.deb`; `apps/mobile`,
`apps/adapter` are in the npm workspaces (`packages/*`, `apps/*`) and slow `npm ci`. `legacy/` is not in workspaces.
`apps/admin` still imports `kiosk.ts` (Android launcher bridge).

### 18. Placeholder screens shipped
`cameras` and `remote` pages in `apps/admin/src/App.tsx:940-941` are "FUTURE INTEGRATION" panels in the nav.

### 19. Admin build needs secrets-shaped env to compile
`npm run build -w @floor/admin` fails without `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (thrown in the Vite
config). Fine for Netlify, but CI can't build the admin app without them (`tsc --noEmit` alone passes).

---

## Code vs live database
I could not query live, so I can't list concrete drift. Known/likely spots to check first:
1. Whether every file in `supabase/migrations` after `recovered-live-versions.txt` is in the live ledger
   (`supabase migration list`).
2. RLS on `manufacturer_photos` (#2) and grants on `units_pos` (#3).
3. That the live definitions of the 17×/15×/14× functions (#11) match the newest repo file
   (`select pg_get_functiondef('public.portal_web_orders'::regproc)`).
4. That the migration from unmerged PR #111 (#9) was never applied.
