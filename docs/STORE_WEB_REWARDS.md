# Store web rewards (quote API)

The public storefront uses Floor's shared loyalty records for signup, checkout
quotes, and member lookup. This endpoint remains available for server-side quote
previews.

## Endpoint

`POST /.netlify/functions/rewards-quote`

Hosted on the Floor Netlify site (same project as Square/eBay functions).

## Auth

Send a shared secret header (either works):

| Header | Env on Netlify |
|--------|----------------|
| `x-store-web-key: <secret>` | `STORE_WEB_REWARDS_KEY` (preferred) |
| `x-connections-key: <secret>` | falls back to `CONNECTIONS_KEY` if `STORE_WEB_REWARDS_KEY` unset |

Do **not** put the service role key in the browser. Call this from the storefront
server (SSR / edge) only.

## Request body

```json
{
  "store_id": "<uuid>",
  "phone": "+1 (555) 010-0200",
  "redeem_points": 0,
  "discount_bps": 0,
  "lines": [
    { "price_cents": 1999, "qty": 1 },
    { "price_cents": 500, "qty": 2 }
  ]
}
```

- `phone` is normalized to digits only server-side.
- Prefer `lines` (unit `price_cents` × `qty`). If lines are unknown yet, pass
  `subtotal_cents` instead for a rough preview.
- `discount_bps` is an optional clerk/ticket % discount (0–10000).
- `redeem_points` uses customer-facing points; the response clamps to the
  available balance and remaining subtotal.

## Response (200)

```json
{
  "ok": true,
  "enabled": true,
  "customer": {
    "id": "...",
    "phone": "5550100200",
    "name": "Ada",
    "email": null,
    "first_purchase_discount_used": false,
    "balance": 12,
    "credit_cents": 120
  },
  "quote": {
    "raw_subtotal_cents": 2999,
    "discount_bps": 0,
    "discount_cents": 0,
    "signup_discount_cents": 150,
    "redeem_points": 0,
    "redeem_cents": 0,
    "max_redeem_points": 12,
    "subtotal_cents": 2849,
    "tax_cents": 207,
    "total_cents": 3056,
    "earn_points_preview": 2.8,
    "point_value_cents": 10,
    "points_per_100_dollars": 10
  }
}
```

If the phone is unknown, `customer` is `null` but `quote` still reflects ticket
discount + tax on the cart (no signup/redeem). The shopper can join at `/rewards`
or inline at checkout; checkout only attaches an existing member account.

If rewards are disabled for the store: `{ "ok": true, "enabled": false, "customer": null }`.

## Discount order (matches POS `finalize_ticket`)

1. Ticket `%` discount on raw subtotal  
2. Signup 5% (default) on remaining, once per customer  
3. Points redeem (every 100 points = $10 off)
4. Tax on the after-discount subtotal  

Customer-facing earn rate: every $100 spent = 10 points. The quote endpoint
returns fractional points to tenths for smaller orders. Marketplace channels
(eBay/Amazon/etc.) never earn or redeem — website + floor only.

## Env checklist (Netlify)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE`
- `STORE_WEB_REWARDS_KEY` (or reuse `CONNECTIONS_KEY`)

The website signup proxy and checkout API call the same store-scoped customer
records as the register. Its server-only shared key is `STORE_WEB_KEY` on the
storefront and `STORE_WEB_REWARDS_KEY` (or `CONNECTIONS_KEY`) on Floor.
