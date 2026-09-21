# Floor on iPhone

Supabase project **floor** (`https://zoukmsmbztcuyoslvikp.supabase.co`) holds
inventory. The phone is a Capacitor 8 client. **Offline selling and receiving
are blocked.** The cache never stores acquisition cost or floor price.

## Roles

Enforced in Postgres, not just the UI.

- **Owner:** everything, including Connections and the manager PIN.
- **Manager:** inventory, sales, reports, voids. Not Connections.
- **Staff:** look up, receive, photos, ring up, delist. No cost, floor, reports, Connections, or settings.

Voids, below-floor prices, and deletes need a manager PIN (5 wrong tries locks it for 5 minutes; failures are logged).

## Staff login

Sign up in the app creates the store. Invite others from Setup.

## Build the IPA

1. App ID `com.openboxindustries.floor`, team `4SRR4NV35F`.
2. **Sandbox Square card testing:** tag `ios-square-*` → Codemagic **Floor iOS Square sandbox (ad-hoc)** → open the Safari OTA link from the build log (`FLOOR AD-HOC OTA INSTALL`) or Artifacts `floor-ota-install-url.txt`. Set `CODEMAGIC_TOKEN` + `IOS_DEVICE_UDID` (+ Netlify OTA vars) in group **appstore**. See `docs/SQUARE.md`.
3. **TestFlight (no MockReaderUI):** tag `ios-*` that is **not** `ios-square-*` → workflow **Floor iOS (TestFlight)**. Use this path for a real Square Reader in production.
4. Push notifications: not in this IPA (no entitlements). Settings shows “Push not set up.” Resend email works once Netlify env is set.

## Netlify env

```
SUPABASE_URL=https://zoukmsmbztcuyoslvikp.supabase.co
SUPABASE_SERVICE_ROLE
CONNECTIONS_KEY          # 32-byte hex
RESEND_API_KEY
RESEND_FROM              # e.g. Floor <alerts@yourdomain>
OAUTH_REDIRECT_URI       # https://<site>/.netlify/functions/oauth-callback (Square/Amazon). eBay uses EBAY_RU_NAME; Auth Accepted URL can be this same callback. Floor opens /.netlify/functions/oauth-go?n=… then hops to eBay.
APP_DEEP_LINK            # floor://connections
ALERT_WEBHOOK_SECRET
SQUARE_APPLICATION_ID
SQUARE_APPLICATION_SECRET
SQUARE_ENV=sandbox
EBAY_CLIENT_ID           # App ID (Client ID) from the sandbox keyset
EBAY_DEV_ID              # Dev ID (stored; Inventory REST uses App ID + Cert ID)
EBAY_CLIENT_SECRET       # Cert ID (Client Secret) from the sandbox keyset
EBAY_RU_NAME             # RuName from User Tokens → Get a Token from eBay via Your Application
EBAY_ENV=sandbox         # never production until we switch
EBAY_NOTIFICATION_TOKEN  # 32–80 random chars you invent (same value in Netlify)
EBAY_NOTIFICATION_ENDPOINT  # https://<functions-site>/.netlify/functions/ebay-notify
AMAZON_APPLICATION_ID
AMAZON_LWA_CLIENT_ID
AMAZON_LWA_CLIENT_SECRET
```

Optional later: `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`.

## After import

Phone SQLite is a cache. Do not restore the JSON backup onto the phone as the ledger.
