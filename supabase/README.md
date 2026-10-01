# Supabase

Project **floor**: `https://zoukmsmbztcuyoslvikp.supabase.co`

## Production migrations

The Supabase CLI is pinned in the root `package.json`. After `npm ci`, run
`npx supabase login` once, then `npx supabase link --project-ref zoukmsmbztcuyoslvikp`
in this repo. Review `npx supabase migration list --linked` and
`npx supabase db push --linked --dry-run --skip-vault` before applying pending
migrations with `npx supabase db push --linked --skip-vault`. CLI login stays in
the machine's credential manager; the local project link is ignored by Git.

GitHub (`Lordsleezy/inventory`, `master`) tracks `migrations/`; the CLI applies
pending versions to production.

## After migrate

1. Authentication → Email. You create the first store **in the app**, not here.
2. Confirm bucket `unit-photos` is **private**.
3. Photos are `{store_id}/{sku}/{filename}`. Anon signed-URL only while that
   store+SKU is in `storefront_items`.
4. Website (other repo): `.from('storefront_items').eq('store_id', STORE_ID)`.

## Sell RPC

```
reserve_unit(sku, channel) → reservation
-- charge (cash is a no-op)
finalize_sale(..., reservation_id, tax_cents, approval_id)
```

## Alerts

`alert_outbox` rows are sent by `/.netlify/functions/dispatch-alerts`.
Add a Database Webhook on `alert_outbox` INSERT, or hit the function on a schedule.
