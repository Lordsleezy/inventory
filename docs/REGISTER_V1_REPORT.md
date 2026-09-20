# register-v1 — delivery report

Branch: `register-v1` (not merged to `master`). Migrations **do not** apply to live Floor until you merge.

## Commits (order)

1. `Prepare register packaging, docs, and remove MarkSold` — A/B/D  
2. `Add atomic register tickets with server-side tax` — 0024 + tax tests  
3. `Add register cart checkout and inventory screens` — POS UI + cloud ticket client  
4. (this push) Phase 2: pgTAP scaffold, channels eval, Square handoff scaffold, Metabase, reporting migration  

---

## Phase 1

### Step 1 — packaging / MarkSold / docs
- `.gitignore`: `apps/pos/packaging/bin/`, `src-tauri/target/`, `gen/` (once each). Left `apps/mobile/android/` alone (already ignored, untracked).
- Deleted unused `MarkSold.tsx` (`sellUnit` remains for store unit tests only).
- `docs/POS.md`, kiosk wrapper `floor-pos-kiosk` + optional `/etc/floor-pos/webkit.env`.

### Step 2 — migration `0024_register_tickets.sql`
- `finalize_ticket`: `FOR UPDATE` on units, server-side tax via `allocate_line_taxes` (numeric half-up), idempotent on `p_ticket_id`, ask price from DB for `list_price_cents`, override reason required when price ≠ ask, `override_by = auth.uid()`.
- No `taxRateBps` seed; new stores omit rate → `tax_rate_required`. `taxPricing` default `added`.
- Duplicate SKU / missing SKU errors include the SKU.
- `void_ticket` + `sale_relist` alerts; approvals bind `ticket_id` and are consumed.
- `store_tax_rate_bps()` takes **no** store argument; execute revoked from `authenticated`.
- PGlite: `scripts/test-ticket-tax.mjs` proves 200×725bps → 14.5 → **15**.

**Live DB risk:** `DROP VIEW sale_receipts` then recreate (adds columns). Brief moment clients might miss the view during deploy — apply in maintenance window or accept one failed request.

### Step 3 — checkout
- Cart → tender → cash received / change → `finalize_ticket` → done (print/skip) → receipts reprint.
- Failures show errors; **no outbox enqueue** on new sales. Legacy outbox sync remains for old rows only.
- Settings: tax % → `set_store_setting('taxRateBps')`. Checkout blocked until set.
- Void latest ticket from Receipts (manager or PIN).
- Card tender button present but blocked until Square handoff is live.

### Step 4 — inventory tab
- Browse/search, unit detail, receive (+ save & add another), disk photo upload to `unit-photos`.
- Managers: full fields including cost/floor. Staff: `units_pos` view-only.
- Not ported: eBay bulk listing UI, manufacturer photos, phone hydrate SQLite (live Supabase instead).

---

## Phase 2

### Step 5 — pgTAP
- `supabase/tests/pgtap/` + docker-compose + `001_tickets.sql` + `run.sh`.
- Existing PGlite migration + ticket-tax scripts kept.
- **Not run here:** no Docker Postgres on this agent host. Run on Legion or locally after `docker compose up`.

### Step 6 — channel libraries
- See `docs/CHANNELS.md`. **Decision: keep custom eBay stack; defer amazon-sp-api until listing exists.**

### Step 7 — Square (sandbox scaffold)
- `0025_pos_card_handoff.sql`: `pos_devices`, `card_charges`, `square_connections`, pair/heartbeat/finalize RPCs.
- Netlify: `square.mjs` (official SDK), `square-oauth-callback`, terminal/refund stubs.
- Phone: `PaymentDevice` screen + Setup link; plugin Swift stub with `#if canImport(SquareMobilePaymentsSDK)` and mock charge IDs.
- Register Card still shows “not wired” until you finish pairing + charge insert from Tender (next slice).
- **Tokens:** currently stored plaintext in `square_connections` with a TODO to encrypt via `CONNECTIONS_KEY`.

### Step 8 — Metabase
- `infra/metabase/docker-compose.yml` for Legion.
- `0026_reporting_role.sql`: `floor_reporting` SELECT-only + `report_sales_by_day` / `report_inventory_aging`.
- `docs/REPORTING.md` setup + starter question list.

---

## What you must do by hand

1. **Review/merge** `register-v1` when ready (applies 0024–0026 on Floor).  
2. **Settings → tax rate** `7.25` after 0024.  
3. **Square keys** in Netlify + `.env` (see `.env.example` / `docs/SQUARE.md`).  
4. **Codemagic:** add Square Mobile Payments SDK SPM to iOS project; first device build checklist in `docs/SQUARE.md`.  
5. **Legion:** Metabase compose + `alter role floor_reporting login password …`.  
6. **Register test plan:** set tax → add 2 SKUs → override one with reason → cash + change → print → void ticket → confirm phone inventory / relist alert.  
7. **pgTAP:** `cd supabase/tests/pgtap && docker compose up -d && bash run.sh` (may need supabase Postgres image pull).

---

## Sketchy / unfinished

- Card tender on register does not yet insert `card_charges` or call phone reader end-to-end.  
- `finalize_register_charge` derives merchandise as `amount - tax`; prefer sending pre-tax line prices from the ticket.  
- Square token encryption not implemented.  
- `approve_with_pin` 3-arg overload dropped — mobile PIN calls should pass `p_ticket_id: null` (Supabase accepts missing optional args).  
- Inventory listing_body / show_on_website still broken on phone vs cloud allowlist (pre-existing).  
- Receive screen category datalist not wired to store settings lists.  
- WebP derivatives not run on register photo upload (raw upload + `add_unit_photo` only).

---

## Decisions I’d revisit

- Encrypt Square tokens before production.  
- Split `finalize_register_charge` to require explicit ticket lines from the register.  
- Add Tailwind or shared UI package if inventory screens grow.  
- Run Metabase against a read replica if Supabase load becomes an issue.
