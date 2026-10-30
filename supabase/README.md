# Supabase

Project **floor**: `https://zoukmsmbztcuyoslvikp.supabase.co`

## Production migrations

Agents do not apply migrations to the live project. The daily release job
(`scripts/release/promote.mjs`) runs `supabase db push --project-ref zoukmsmbztcuyoslvikp --yes --skip-vault`
against `master` before it fast-forwards `release`. The Supabase GitHub
integration's production branch is `release`, not `master`.

The Supabase CLI is pinned in the root `package.json`. `npx supabase migration list --project-ref zoukmsmbztcuyoslvikp`
is read-only and is safe for checking drift. Do not run `supabase db push` against this project from a workstation.

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
