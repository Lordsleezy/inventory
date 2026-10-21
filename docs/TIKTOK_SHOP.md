# TikTok Shop Open API (US Custom app)

Floor integration for Open Box Industries / inventoryobi. Keys are **not** in Netlify yet — functions no-op with clear errors until env + OAuth exist. Do not invent live API success.

## Env vars (Netlify)

| Variable | Required | Notes |
|----------|----------|-------|
| `TIKTOK_SHOP_APP_KEY` | yes | Partner Center app key |
| `TIKTOK_SHOP_APP_SECRET` | yes | Partner Center app secret (signing + token exchange) |
| `TIKTOK_SHOP_SERVICE_ID` | optional | Custom app Service ID → authorize URL uses `services.tiktokshop.com/open/authorize` |
| `TIKTOK_SHOP_SHOP_ID` | yes (for shop-scoped calls) | Seller shop id |
| `TIKTOK_SHOP_API_BASE` | no | Default `https://open-api.tiktokglobalshop.com` (US partner base if Partner Center says otherwise) |
| `TIKTOK_SHOP_AUTH_BASE` | no | Default `https://auth.tiktok-shops.com` |
| `TIKTOK_SHOP_REDIRECT_URL` | no | Defaults to the URL below |
| `TIKTOK_SHOP_ACCESS_TOKEN` | bootstrap only | Prefer OAuth tokens in `connections` |
| `TIKTOK_SHOP_LISTING_ENABLED` | no | Set `1` to allow product push |
| `TIKTOK_SHOP_FEE_PCT` | no | Default `0.08` for list-price bake-in |
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
- `seller.product.read`
- `seller.product.write`
- `seller.order.info`
- `seller.order.refund`
- `seller.return_refund.basic`
- `seller.fulfillment.basic`

Also subscribe webhooks (order + return) to:

```
https://inventoryobi.netlify.app/.netlify/functions/tiktok-webhook
```

Scheduled polls remain authoritative (`tiktok-orders-sync` every 10m, `tiktok-returns-sync` / `returns-sync` every 30m).

## What Floor builds

1. **OAuth** — `tiktok-oauth-callback`, `oauth-authorize` / `oauth-start` for `tiktok`
2. **Token refresh** — `netlify/lib/tiktok-shop.mjs` refreshes before expiry; emails `FLOOR_OWNER_EMAIL` on failure
3. **Product push** — `tiktok-list` + `portal_tiktok_list` / `portal_tiktok_list_add`; pricing = same online rule as Amazon + TikTok fees + return reserve; real photos only; errors in Marketplaces → TikTok Shop panel
4. **Orders** — webhook + `tiktok-orders-sync` → `finalize_sale` → delist TikTok / eBay / Amazon qty
5. **Returns** — live `return_refund/.../returns/search` when tokens present → `ingest_channel_return` → `return_decision` alert; **48h** decision window already in `return_settings.decision_hours.tiktok`

## Smoke tests (after keys)

```bash
curl -sS -X POST 'https://inventoryobi.netlify.app/.netlify/functions/tiktok-returns-sync' \
  -H 'content-type: application/json' -d '{"action":"status"}'

curl -sS -X POST 'https://inventoryobi.netlify.app/.netlify/functions/tiktok-list' \
  -H "authorization: Bearer $PORTAL_JWT" \
  -H 'content-type: application/json' -d '{"action":"status"}'
```
