# Depop agent confirmation

After every Depop listing has actually published, record it through the service-role RPC `floor_depop_record_listing` using Floor's existing Supabase connection. Keep the key in Netlify environment configuration and never print it. Do not use a signed-in portal RPC with the service credential.

Arguments: `p_store` (store UUID), `p_sku`, `p_url` (the confirmed Depop product URL), `p_price_cents` (the actual published price), `p_listed_at` (publication timestamp), `p_actor` (agent name). Verify a `listings` row with this store/SKU/channel=depop/status=listed before moving to another item. The call is idempotent. If recording fails, preserve the published URL outside git and retry that confirmation; never create the listing again.

This RPC records existing publications only. It does not publish to Depop. Agents must still check the live shop for duplicates, use actual unit photos, obey Depop's current prohibited-items policy, exclude DNS/do-not-list/Defective/sold items, and respect the owner's price, shipping and pacing instructions. Missing URL/date/price may be NULL only when importing an owner-confirmed historical SKU list; never invent values.

The portal form remains admin-only. Clerks and anonymous clients cannot execute the service-only confirmation function. Recording a Depop sale removes its canonical listing row from the live tracker; deleting/voiding a sale never automatically republishes it.
