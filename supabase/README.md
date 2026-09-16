# Supabase

Apply `migrations/` in order (0001 → 0009).

## After migrate

1. Authentication → Email. You create the first store **in the app**, not here.
2. Confirm bucket `unit-photos` is **private**.
3. Photos are `{store_id}/{sku}/{filename}`. Anon signed-URL only while that
   store+SKU is in `public_items`.
4. Website (other repo): `.from('public_items').eq('store_id', STORE_ID)`.

## Sell RPC

```
reserve_unit(sku, channel) → reservation
-- charge (cash is a no-op)
finalize_sale(..., reservation_id, tax_cents, approval_id)
```

## Alerts

`alert_outbox` rows are sent by `/.netlify/functions/dispatch-alerts`.
Add a Database Webhook on `alert_outbox` INSERT, or hit the function on a schedule.
