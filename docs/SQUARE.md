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
`https://github.com/square/mobile-payments-sdk-ios` exact **2.6.0** (`SquareMobilePaymentsSDK` only).

**MockReaderUI is not a plugin dependency.** Square packages it as an application bundle
(`CFBundlePackageType = APPL`, bundle id `com.squareup.readersdk.mockreaderui`). App Store
Connect rejects any IPA that embeds it. Square’s guidance: Debug / sandbox only; never ship
in a Release archive that goes to ASC. The plugin uses `#if canImport(MockReaderUI)`.

`npx cap sync ios` regenerates `CapApp-SPM`. `scripts/ios-square-prepare.sh` then:

- bumps deployment target to iOS 16
- disables User Script Sandboxing
- adds Square’s `SquareMobilePaymentsSDK.framework/setup` run-script phase
- writes Bluetooth / location / microphone plist keys
- sets `SquareApplicationID` from `SQUARE_APPLICATION_ID` (**required** — prepare fails if unset)
- injects **FloorSquarePlugin** + **SquareMobilePaymentsSDK** into CapApp-SPM
- if `FLOOR_INCLUDE_MOCK_READER=1`, also injects **MockReaderUI** (ad-hoc sandbox builds only)

`scripts/verify-ios-square-ipa.sh` fails the build if Square is missing, if Application ID is
`REPLACE_ME`, or if MockReaderUI presence doesn’t match `FLOOR_INCLUDE_MOCK_READER`.

## Two Codemagic paths

| Tag | Workflow | MockReaderUI | Signing | Install |
|-----|----------|--------------|---------|---------|
| `ios-square-*` | **Floor iOS Square sandbox (ad-hoc)** | yes | Ad Hoc | Codemagic artifact → Apple Configurator / Xcode Devices |
| `ios-*` (not square) | **Floor iOS (TestFlight)** | no | App Store | TestFlight |

Sandbox card charges **require** MockReaderUI (physical readers unsupported in Square sandbox).
That build cannot upload to TestFlight — install the ad-hoc IPA instead.

### Install ad-hoc (`ios-square-*`)

1. Register your iPhone UDID in [Apple Developer → Devices](https://developer.apple.com/account/resources/devices/list) (once).
2. Tag `ios-square-N` → wait for Codemagic **Floor iOS Square sandbox (ad-hoc)** to finish.
3. Codemagic → build → **Artifacts** → download `.ipa`.
4. Mac: **Apple Configurator 2** → select phone → Add → the IPA  
   or **Xcode → Window → Devices and Simulators** → install the IPA.
5. On phone, trust the developer cert if prompted (Settings → General → VPN & Device Management).
6. Authorize Square → tap the floating mock reader → add contactless → Take payment.

### TestFlight (`ios-*` without `square`)

Production-shaped binary (no MockReaderUI). Fine for UI / pairing plumbing; sandbox Take
payment will refuse until you use an `ios-square-*` ad-hoc build (or a physical reader in
production with a production Application ID).

## Register: Connect Square

1. Settings → **Connect Square** → authorize → **List locations** → pick location.
2. Phone **Payment device** → pair code → register **Pair**.
3. Cart → Card → Charge on phone.

## Before production

- `SQUARE_ENVIRONMENT=production` + production Application ID/Secret + redirect.
- Live OAuth; Square application signature (bundle ID + team ID).
- Ship TestFlight / App Store builds **without** MockReaderUI (`FLOOR_INCLUDE_MOCK_READER` unset).
- Do not ship sandbox test tokens.

## License

Donut Counter / Mobile Payments sample patterns — keep NOTICE when vendoring bridge code.
