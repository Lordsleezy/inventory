# Square (sandbox) — register + phone reader

## Netlify env (exact names)

| Variable | Where |
|----------|--------|
| `SQUARE_APPLICATION_ID` | Netlify + Codemagic group **appstore** (public; used to initialize the iOS SDK) |
| `SQUARE_APPLICATION_SECRET` | Netlify only |
| `SQUARE_ENVIRONMENT` | `sandbox` |
| `SQUARE_REDIRECT_URL` | `https://<site>/.netlify/functions/square-oauth-callback` |
| `CONNECTIONS_KEY` | Netlify — encrypts tokens in `square_connections` |
| `SQUARE_SANDBOX_ACCESS_TOKEN` | Optional Default Test Account token |
| `SQUARE_SANDBOX_LOCATION_ID` | Optional sandbox Location ID |

Also: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`.

## How the iOS SDK is linked (no manual Xcode)

`packages/square-plugin/Package.swift` depends on
`https://github.com/square/mobile-payments-sdk-ios` exact **2.6.0** (`SquareMobilePaymentsSDK`).

`npx cap sync ios` regenerates `CapApp-SPM` and pulls `FloorSquarePlugin` (and thus Square) into the app.
`scripts/ios-square-prepare.sh` then:

- bumps deployment target to iOS 16
- disables User Script Sandboxing
- adds Square’s `SquareMobilePaymentsSDK.framework/setup` run-script phase
- writes Bluetooth / location / microphone plist keys
- sets `SquareApplicationID` from `SQUARE_APPLICATION_ID`
- verifies / injects `FloorSquarePlugin` into CapApp-SPM if sync skipped it

MockReaderUI is **not** linked (breaks App Store upload). Sandbox mock charges use the plugin’s `mock: true` path when needed.

## Register: Connect Square

1. Settings → **Connect Square** → authorize → **List locations** → pick location.
2. Phone **Payment device** → pair code → register **Pair**.
3. Cart → Card → Charge on phone.

## First Codemagic / TestFlight checklist

1. Ensure Codemagic group **appstore** has `SQUARE_APPLICATION_ID` (sandbox Application ID).
2. Push / build branch `square-v1` — workflow resolves SPM and builds IPA for TestFlight.
3. Build log must show Square package resolve (`mobile-payments-sdk-ios` / `SquareMobilePaymentsSDK`) and IPA upload.
4. On device: Payment device → Authorize Square → take a sandbox payment (mock path OK until a reader / Mock Reader UI is added separately for Debug).
5. Watch Netlify logs for `square-oauth-callback`, `square-mobile-auth`, `square-refund-payment`.

## Before production

- `SQUARE_ENVIRONMENT=production` + production Application ID/Secret + redirect.
- Live OAuth; Square application signature (bundle ID + team ID).
- Do not ship sandbox test tokens.

## License

Donut Counter / Mobile Payments sample patterns — keep NOTICE when vendoring bridge code.
