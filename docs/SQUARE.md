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
| `ios-square-*` | **Floor iOS Square sandbox (ad-hoc)** | yes | Ad Hoc | Safari OTA link (no Mac) |
| `ios-*` (not square) | **Floor iOS (TestFlight)** | no | App Store | TestFlight |

Sandbox card charges **require** MockReaderUI (physical readers unsupported in Square sandbox).
That build cannot upload to TestFlight — install via the OTA link instead.

### One-time setup (Codemagic group **appstore**)

| Variable | Why |
|----------|-----|
| `CODEMAGIC_TOKEN` | **Required for OTA.** Codemagic → User settings → Integrations → Codemagic API → copy token |
| `IOS_DEVICE_UDID` | **Required for Ad Hoc.** Your iPhone UDID so the provisioning profile includes the phone |
| `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` | **Preferred.** Hosts the Safari install page (alias `ota-<tag>`) |
| `GITHUB_TOKEN` | Fallback host for the OTA manifest if Netlify vars are missing |
| `RESEND_API_KEY` + `RESEND_FROM` | Optional — emails you the install URL + QR |

### Get your UDID (no Mac)

1. On the iPhone, open **Safari** → [https://udid.tech](https://udid.tech) → install the temporary profile → copy the UDID.
2. Paste it into Codemagic group **appstore** as `IOS_DEVICE_UDID`.
3. Or: Codemagic → **Team settings → iOS test devices** → create a tester group → email yourself the registration link (QR on phone).

Each `ios-square-*` build runs `scripts/register-ios-device.sh` then recreates the Ad Hoc profile so your UDID is covered.

### Install ad-hoc from the phone (`ios-square-*`)

1. Tag `ios-square-N` → wait for **Floor iOS Square sandbox (ad-hoc)**.
2. Get the install URL (any of these):
   - Codemagic build log → search **`FLOOR AD-HOC OTA INSTALL`**
   - Build **Artifacts** → `floor-ota-install-url.txt`
   - Email (if Resend vars are set)
3. On the iPhone open that URL in **Safari** (not Chrome) → **Install**.
4. If prompted: Settings → General → VPN & Device Management → trust the developer cert.
5. Authorize Square → tap the floating mock reader → add contactless → Take payment.

### TestFlight (`ios-*` without `square`)

Production-shaped binary (no MockReaderUI). Fine for UI / pairing; sandbox Take payment will
refuse until you use an `ios-square-*` OTA build (or a physical reader in production).

## Register: Connect Square

1. Settings → **Connect Square** → authorize → **List locations** → pick location.
2. Phone **Payment device** → pair code → register **Pair**.
3. Cart → Card → Charge on phone.

## Switching to production (real Square Reader / free-processing window)

Sandbox cannot use physical readers. If you have a Cube and free processing, going live is
usually simpler than fighting MockReaderUI + Ad Hoc forever.

| Step | What |
|------|------|
| 1. Square Developer Console | Toggle to **Production**. Copy **Production** Application ID + Application Secret. |
| 2. App signature (required for MPSDK ≥ 2.1) | Console → your app → **Mobile Payments SDK** → Add signature: bundle ID `com.openboxindustries.floor`, team ID `4SRR4NV35F`. |
| 3. OAuth redirect | Same redirect URL works if already registered for production; confirm Production redirect allow-list includes `https://<site>/.netlify/functions/square-oauth-callback`. |
| 4. Netlify env | `SQUARE_ENVIRONMENT=production`, `SQUARE_APPLICATION_ID=<prod>`, `SQUARE_APPLICATION_SECRET=<prod>`, clear/ignore sandbox token vars. Redeploy Netlify. |
| 5. Codemagic | Set `SQUARE_APPLICATION_ID` in group **appstore** to the **production** Application ID (baked into the IPA). |
| 6. Build | Tag an `ios-*` **TestFlight** build (no MockReaderUI) — e.g. `ios-11`. Install from TestFlight. |
| 7. Re-Connect Square | In the app: disconnect/reconnect **Connect Square** so OAuth stores a **production** token + pick a **production** location. Sandbox tokens will not authorize production SDK. |
| 8. Pair the Cube | Payment device → Square settings → pair the physical reader (Bluetooth + location on). |
| 9. Charge | Cart → Card → Take payment with a real card. Free-processing window still settles as live payments — use a real card you control and refund if needed. |

You do **not** need MockReaderUI or Ad Hoc once production Application ID is in the IPA and
OAuth is production. Keep `FLOOR_INCLUDE_MOCK_READER` unset for TestFlight / App Store.

## Before production (checklist)

- `SQUARE_ENVIRONMENT=production` + production Application ID/Secret + redirect.
- Mobile Payments SDK application signature (bundle ID + team ID).
- Re-do Connect Square; pick production location.
- Ship TestFlight builds **without** MockReaderUI.
- Do not ship sandbox test tokens.

## License

Donut Counter / Mobile Payments sample patterns — keep NOTICE when vendoring bridge code.
