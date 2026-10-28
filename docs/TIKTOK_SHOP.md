# TikTok Shop Open API (US Custom app)

Floor integration for Open Box Industries / inventoryobi. Keys are **not** in Netlify yet — functions no-op with clear errors until env + OAuth exist. Do not invent live API success.

## Env vars (Netlify)

| Variable | Required | Notes |
|----------|----------|-------|
| `TIKTOK_SHOP_APP_KEY` | yes | Partner Center app key |
| `TIKTOK_SHOP_APP_SECRET` | yes | Partner Center app secret (signing + token exchange) |
| `TIKTOK_SHOP_SERVICE_ID` | optional | Partner Center Service ID; US authorize host is `services.us.tiktokshop.com/open/authorize` |
| `TIKTOK_SHOP_SHOP_ID` | optional bootstrap | Authorized shop IDs are read from TikTok and stored in the service-only `tiktok_shop_accounts` table |
| `TIKTOK_SHOP_SHOP_CIPHER` | optional bootstrap | Authorized shop cipher is stored server-side after OAuth; do not set unless diagnosing a shop-context issue |
| `TIKTOK_SHOP_API_BASE` | no | Default `https://open-api.tiktokglobalshop.com` (US partner base if Partner Center says otherwise) |
| `TIKTOK_SHOP_AUTH_BASE` | no | Default `https://auth.tiktok-shops.com` |
| `TIKTOK_SHOP_REDIRECT_URL` | no | Defaults to the URL below |
| `TIKTOK_SHOP_ACCESS_TOKEN` | bootstrap only | Prefer OAuth tokens in `connections` |
| `TIKTOK_SHOP_LISTING_ENABLED` | no | Leave unset for this preparation job; no listing is performed |
| `TIKTOK_SHOP_FEE_PCT` | no | Readiness estimate only; default 0.06. Actual fee varies by category and TikTok's current schedule |
| `TIKTOK_SHOP_WAREHOUSE_ID` | for listing | Required by product create once listing is on |
| `CONNECTIONS_KEY` | yes | Encrypts tokens at rest (same as Amazon/Square) |

Tokens are stored encrypted in `public.connections` with `provider = 'tiktok'` (`token_ciphertext`, `refresh_ciphertext`, `expires_at`).

## Exact OAuth redirect URL

Register this **exactly** in Partner Center → App → Redirect URL:

```
https://inventoryobi.netlify.app/.netlify/functions/tiktok-oauth-callback
```

Admin → Marketplaces → **Authorize TikTok Shop** starts `oauth-start?provider=tiktok` → Partner consent → this callback → encrypted `connections` row.

## Manage API scopes (US seller)

Request under Partner Center → **Manage API** (names vary slightly by console locale; request the seller order / product / return family):

- `seller.authorization.info`
- `seller.shop.info`
- `seller.product.basic`
- `seller.product.write`
- `seller.order.info`
- `seller.return_refund.basic`
- `seller.fulfillment.basic`
- `seller.logistics`
- `seller.finance.info`

Register this webhook callback URL in Partner Center and subscribe to `ORDER_STATUS_CHANGE`, `CANCELLATION_STATUS_CHANGE`, and `RETURN_STATUS_CHANGE`:

```
https://inventoryobi.netlify.app/.netlify/functions/tiktok-webhook
```

The webhook handler verifies the Shop signature and stores deduplicated raw events only. It does not create sales, process cancellations, or apply returns. Existing scheduled jobs are legacy flows and are not used by this preparation job.

## What Floor builds

1. **OAuth** — `tiktok-oauth-callback`, `oauth-authorize` / `oauth-start` for `tiktok`
2. **Token refresh** — `netlify/lib/tiktok-shop.mjs` refreshes before expiry; emails `FLOOR_OWNER_EMAIL` on failure
3. **Read-only preparation** — `tiktok-list` admin actions pull shop/warehouse, product, order, and brand snapshots into service-only tables. Global brand listings are not treated as category authorization; mapped categories get category-specific brand snapshots. Shipping choices are retained as observed order options because eligibility depends on a real order and package.
4. **Money** — the Money tab's explicit TikTok refresh imports PAID USD finance payments by payment ID, idempotently, and shows unsettled funds as an estimate. This account is marked as Paul's personal bank, not Floor business cash.
5. **Product push** — existing `tiktok-list` and queue controls remain a later job; the preparation flow does not create/edit/delete TikTok products.
6. **Orders and returns** — existing ingestion paths remain; this preparation webhook only stores notifications, without applying them.

## Smoke tests (after keys)

```bash
curl -sS -X POST 'https://inventoryobi.netlify.app/.netlify/functions/tiktok-returns-sync' \
  -H 'content-type: application/json' -d '{"action":"status"}'

curl -sS -X POST 'https://inventoryobi.netlify.app/.netlify/functions/tiktok-list' \
  -H "authorization: Bearer $PORTAL_JWT" \
  -H 'content-type: application/json' -d '{"action":"status"}'
```
