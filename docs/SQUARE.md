# Square (sandbox) — register + phone reader

## Netlify env (exact names)

| Variable | Where |
|----------|--------|
| `SQUARE_APPLICATION_ID` | Netlify (already set) |
| `SQUARE_APPLICATION_SECRET` | Netlify (already set) |
| `SQUARE_ENVIRONMENT` | `sandbox` (already set) |
| `SQUARE_REDIRECT_URL` | `https://<site>/.netlify/functions/square-oauth-callback` — must match Square console |
| `CONNECTIONS_KEY` | Netlify (already set) — encrypts tokens in `square_connections` |
| `SQUARE_SANDBOX_ACCESS_TOKEN` | Optional: Default Test Account token from Square console (sandbox API without OAuth) |
| `SQUARE_SANDBOX_LOCATION_ID` | Optional: sandbox Location ID for the test account |

Also: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`.

## Register: Connect Square

1. Settings → **Connect Square** (opens OAuth; state = store_id).
2. **Refresh status** → **List locations** → pick location.
3. Open phone **Payment device**, note pair code → register **Pair**.
4. Cart → Card → Charge on phone.

## Sandbox end-to-end test (mock reader)

1. Deploy Netlify from `square-v1` (or set env and run functions locally).
2. Apply migration `0028` on Floor (via merge later — or `supabase db push` only if you intend to).
3. Set tax rate 7.25% in Settings.
4. On phone (TestFlight or simulator): Payment device → Authorize Square (mock if not connected).
5. Register: pair phone; add 2 available SKUs to cart; **Card** → **Charge card on phone**.
6. Phone: **Take payment** (mock returns VISA •••• 1111).
7. Register should leave waiting state → Done → print; receipt shows card brand/last4.
8. Failure drills: Cancel while waiting; decline on phone; sell one SKU elsewhere mid-wait then confirm refund attempt.

## First Codemagic / TestFlight build checklist

1. Start a **manual** Codemagic build of branch `square-v1` (or push to `square-v1` — workflow includes that branch).
2. In Xcode (or via package UI on the Mac mini): add SPM `https://github.com/square/mobile-payments-sdk-ios` and link **SquareMobilePaymentsSDK** to App. The prepare script only adds Bluetooth/location plist keys.
3. Confirm build log shows `FloorSquarePlugin.swift` compiling with `canImport(SquareMobilePaymentsSDK)` true (not only the stub path).
4. Install TestFlight build → Settings → Payment device → Authorize → pair code visible.
5. Confirm Bluetooth permission prompt appears when pairing a reader.
6. Sandbox: enable **Mock Reader** in Square Dashboard / SDK sample flow if using hardware simulation.
7. Watch Netlify logs for `square-oauth-callback`, `square-mobile-auth`, `square-refund-payment`.

## Before production

- Switch `SQUARE_ENVIRONMENT=production`, production Application ID/Secret, production redirect URL.
- Complete OAuth with the live merchant (do not use sandbox test token).
- Square app signature / Mobile Payments production credentials as required by Square.
- Encrypt path already uses `CONNECTIONS_KEY` — rotate if it was ever logged.
- Turn off mock charges (`mock: false`) once the real SDK is linked and authorized.

## License

`square/mobile-payments-sdk-react-native` sample patterns are Apache 2.0 — keep NOTICE when vendoring bridge code.
