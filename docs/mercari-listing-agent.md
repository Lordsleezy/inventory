# Mercari agent confirmation

After every Mercari listing has actually published, record it through the service-role RPC `floor_mercari_record_listing` using Floor's existing Supabase connection. Keep the key in Netlify environment configuration and never print it. Signed-in portal users still require administrator access via `portal_mercari_add_listing`.

Arguments: `p_store` (store UUID), `p_sku`, `p_url` (the confirmed Mercari item URL), `p_price_cents` (the actual published price), `p_listed_at` (publication timestamp), `p_actor` (agent name). Verify a `listings` row with this store/SKU/channel=mercari/status=listed before moving to another item. The call is idempotent and enforces the 200 live-listing cap. If recording fails, preserve the published URL outside git and retry that confirmation; never create the listing again.

This RPC records existing publications only. It does not publish to Mercari. Agents must still check the live shop for duplicates, use actual unit photos, exclude DNS/do-not-list/Defective/sold items, and respect the owner's price, shipping and pacing instructions. Missing URL/date/price may be NULL only when importing an owner-confirmed historical SKU list; never invent values.

## Bulk-load already-live shop items

Use Mercari → Listed on Mercari → **Bulk load**. Paste one SKU per line. Optional Mercari URL and price after the SKU:

```
11401 https://www.mercari.com/us/item/m123… 24.99
11402
11403 https://www.mercari.com/us/item/m456…
```

Floor blocks the paste when it would push the shop past **200** live listings.

## Manual sale entry

Mercari → Manual sale entry (or open a live SKU → Mark sold). Enter item price, buyer-paid shipping, label cost, and fee. Fee defaults to **10% of (item + buyer shipping)** and can be overridden. Payout defaults to item + shipping − fee − label. Saving marks the unit sold, removes the Mercari tracker row, opens delist tasks for other listed channels (eBay via API elsewhere), freezes commissions (online = 30% of profit to Paul), and creates a To Ship order.

Recording a Mercari sale removes its canonical listing row from the live tracker; deleting/voiding a sale never automatically republishes it. Use `floor_mercari_remove_listing(p_store,p_sku,p_actor)` to record an actual shop removal; the portal Remove action remains available to admins.

Confirmed Mercari rows are protected from generic legacy imports. All other channel rows remain independent.
