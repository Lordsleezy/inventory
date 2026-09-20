# Square (sandbox) — register + phone reader

## Keys (developer.squareup.com → Applications → your sandbox app)

| Key | Where it goes |
|-----|----------------|
| **Application ID** | Netlify `SQUARE_APPLICATION_ID`; also Codemagic/group if phone needs it for SDK init (prefer server-minted mobile token later) |
| **Application Secret** | Netlify **only** `SQUARE_APPLICATION_SECRET` (never VITE_ / never phone) |
| **Sandbox Access Token** (personal) | Optional for early API tests; production uses OAuth tokens in `square_connections` |
| **OAuth Redirect URL** | `https://<functions-site>/.netlify/functions/square-oauth-callback` — set in Square app → OAuth |

Also ensure Netlify already has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `CONNECTIONS_KEY`.

Add to Codemagic group **appstore** when linking the Mobile Payments SDK:
- Nothing secret required in the IPA for OAuth (tokens stay on Netlify).
- If the SDK needs Application ID at runtime: `SQUARE_APPLICATION_ID` as a build-time define (public).

## First Codemagic build checklist

1. Merge/build branch with Square Mobile Payments SDK added to `apps/adapter/ios` via SPM (`https://github.com/square/mobile-payments-sdk-ios`).
2. Confirm `FloorSquarePlugin.swift` compiles (`canImport(SquareMobilePaymentsSDK)` true on device build).
3. Simulator builds may use the stub `paymentId` path — that is OK for CI.
4. On device: Settings → Payment device → note pair code → register Settings → Pair.
5. Sandbox: enable Mock Reader in Square Dashboard / SDK sample flow (Donut Counter pattern).
6. Watch Netlify function logs for `square-oauth-callback` after Connect Square.

## License

`square/mobile-payments-sdk-react-native` is Apache 2.0 — keep NOTICE when vendoring sample bridge code.
