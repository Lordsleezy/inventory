# Channel libraries (eBay / Amazon)

Evaluation for Floor Netlify functions vs adopting community SDKs.

## What we have today

Custom HTTP clients in `netlify/lib/ebay.mjs` (+ trading, aspects, catalog, photos, errors)
and Amazon OAuth in `oauth-authorize.mjs`. They already encode Floor-specific quirks:

- eBay `#` in authorization codes (iOS / callback reassembly)
- Trading API soldQuantity fallback when Fulfillment omits unpaid-looking orders
- Category condition IDs, aspect mapping from Floor unit fields
- Multi-store token rows in Supabase `connections`

## ebay-api (npm)

**Pros:** Typed REST wrappers, faster to call Inventory/Fulfillment endpoints.  
**Cons:** Does not replace Trading API paths we rely on; still need custom OAuth +
notification handling; another dependency to pin against eBay’s breaking changes.

**Decision:** Keep the current eBay client. Adopting `ebay-api` would duplicate OAuth and
leave Trading/notifications as custom code anyway. Revisit only if we drop Trading entirely.

## amazon-sp-api (npm)

**Pros:** Handles LWA refresh and SP-API signing.  
**Cons:** Floor’s Amazon path is still mostly OAuth stub / consent URL; no full listing
pipeline yet. Adding the SDK before we have listing + order sync is premature.

**Decision:** Do not adopt yet. When Amazon listing ships, prefer `amazon-sp-api` (or
Amazon’s official SDK if one is current) for signing/refresh, and keep Floor’s store-scoped
token storage.

## Summary

| Channel | Adopt now? | Why |
|---------|------------|-----|
| eBay    | No         | Existing custom stack owns Trading + Floor quirks |
| Amazon  | Later     | No listing pipeline yet; SDK useful when that lands |
