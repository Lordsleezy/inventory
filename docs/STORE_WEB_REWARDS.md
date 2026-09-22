# Store web rewards (quote API)

Website checkout is not built yet. This documents how **openbox-store-web** (or any
public storefront) should call Floor for loyalty preview before wire-up.

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
- `redeem_points` is what the shopper wants to redeem; the response clamps to
  balance and remaining subtotal.

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
    "balance": 120
  },
  "quote": {
    "raw_subtotal_cents": 2999,
    "discount_bps": 0,
    "discount_cents": 0,
    "signup_discount_cents": 150,
    "redeem_points": 0,
    "redeem_cents": 0,
    "max_redeem_points": 120,
    "subtotal_cents": 2849,
    "tax_cents": 207,
    "total_cents": 3056,
    "earn_points_preview": 28,
    "point_value_cents": 1,
    "points_per_dollar": 1
  }
}
```

If the phone is unknown, `customer` is `null` but `quote` still reflects ticket
discount + tax on the cart (no signup/redeem). Create the customer on the POS
or via a future signup RPC before checkout can earn points.

If rewards are disabled for the store: `{ "ok": true, "enabled": false, "customer": null }`.

## Discount order (matches POS `finalize_ticket`)

1. Ticket `%` discount on raw subtotal  
2. Signup 5% (default) on remaining, once per customer  
3. Points redeem (each point = `rewards_point_value_cents`, default 1¢)  
4. Tax on the after-discount subtotal  

Earn uses `floor(subtotal_cents * rewards_points_per_dollar / 100)` after discounts.
Marketplace channels (eBay/Amazon/etc.) never earn or redeem — website + floor only.

## Env checklist (Netlify)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE`
- `STORE_WEB_REWARDS_KEY` (or reuse `CONNECTIONS_KEY`)

## Not included yet

- Placing an order / calling `finalize_ticket` from the website  
- Customer self-signup UI  
- Receipt email  

Wire checkout later to the same discount math (or call a staff/service
`finalize_ticket` with `p_channel = 'website'`).
