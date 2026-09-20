# square-v1 delivery

Branch: `square-v1` (not merged to master).

## What shipped

1. **0028_card_ticket_charges** — `lines` jsonb on `card_charges`, `create_register_charge` (server tax-included total), `capture_register_charge` (idempotent), `cancel_register_charge`, rewritten `finalize_register_charge` → **`finalize_ticket`** (same path as cash). Card brand/last4 on sales + receipts. `my_square_connection_status()` (no tokens).

2. **Netlify** — Encrypt tokens with `CONNECTIONS_KEY`; refresh &lt;7 days left; `square-connect-start`, `square-list-locations`, `square-set-store-location`, `square-mobile-auth`, `square-refund-payment`. Optional `SQUARE_SANDBOX_ACCESS_TOKEN` + `SQUARE_SANDBOX_LOCATION_ID`.

3. **Register** — Card tender: create charge → wait on phone → finalize; cancel; refund if finalize fails; Connect Square UI; Done/receipts show brand/last4.

4. **Phone** — PaymentDevice uses capture RPC + Square authorize/charge; Checkout uses FloorSquare (not stub); Swift plugin updated for Mobile Payments SDK + mock path.

5. **Cleanups** — Register WebP derivatives; Receive category/condition from store settings.

6. **Codemagic** — `square-v1` branch trigger; `ios-square-prepare.sh` Bluetooth/location plist.

7. **pgTAP** — `003_card_path.sql` happy path, decline, mid-sale race, duplicate capture/finalize, tax match cash, token lockdown.

## Your hand steps

See `docs/SQUARE.md`. Short version: confirm Netlify env names; add optional sandbox token/location; apply 0028 when merging; Codemagic manual build of `square-v1` and link Square SPM; TestFlight mock-reader walkthrough.
