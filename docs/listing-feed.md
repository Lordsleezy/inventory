# Listing feed

Read-only live inventory for the Codex agent that lists Floor units on Depop and other marketplaces. The feed reads Supabase on each request. It does not cache, and it has no write path.

Codex is the consumer. It must not be given `SUPABASE_SERVICE_ROLE`.

## Endpoint

`GET https://inventoryobi.netlify.app/listing-feed`

Same handler: `GET https://inventoryobi.netlify.app/.netlify/functions/listing-feed`

## Auth

Send the shared secret in a header. A missing or wrong key returns `401`. The key is not accepted in the query string.

```
x-listing-feed-key: <LISTING_FEED_KEY>
```

Codex `.env.local`:

```
LISTING_FEED_URL=https://inventoryobi.netlify.app/listing-feed
LISTING_FEED_KEY=<secret>
```

The secret lives in the Netlify env var `LISTING_FEED_KEY` on inventoryobi (functions scope, production). Copy the value from the local file written at setup time. Do not commit it.

Successful calls are limited to 60 per minute per client. Failed keys are limited to 10 per minute. A limited call returns `429` and `Retry-After`. Responses send `Cache-Control: no-store`.

## Feed

`GET /listing-feed`

Default view is units that are available to sell and ready to list: state `available`, quantity on hand above zero, not a test unit, no unvoided sale, no live reservation, no claimed or unpaid web order, at least one photo, and a Floor price above zero.

| Param | Meaning |
| --- | --- |
| `view` | `available` (default), `photo-ready`, or `all`. `photo-ready` is the same availability rule but does not require a price. `all` includes sold, reserved, and unpriced units. |
| `eligible` | `1` keeps only units whose `eligible` flag is true. |
| `sku` | One SKU or a comma-separated list (max 100). |
| `category` | Case-insensitive exact category. Blank categories do not match. |
| `since` | ISO timestamp. Keeps units whose record, a photo, or a listing row changed at or after that time. |
| `limit` | Page size. Default 25, max 50. |
| `cursor` | SKU returned as `next_cursor` from the previous page. |

`next_cursor` is null on the last page. `total` is the size of the filtered set, not the page.

## Recheck one SKU

Call this immediately before posting a listing. It returns that unit even when the default feed would omit it, so a sale between runs shows up as `available: false`.

`GET /listing-feed?check=99735`

Unknown SKUs return `404`.

Do not post when `available` or `eligible` is false.

## Unit fields

- `sku`, `name`, `title`, `brand`, `model`, `upc`, `category`
- `condition`, `condition_notes` (defect notes), `test_status`
- `floor_price_cents` is the Floor asking price (`units.ask_cents`). `minimum_cents` is the lowest accepted price (`units.floor_cents`). `cost_cents` is acquisition cost. `retail_cents` plus `retail_source_name` / `retail_source_url` when recorded.
- `dimensions.source` is `dims_source` (`verified`, `estimated`, or null), with `product` and `package` height/width/depth or length and weight.
- `quantity`, `status` (`available`, `sold`, `reserved`, and the other unit states)
- `created_at` (received), `updated_at`
- `photos`: signed URLs from the private `unit-photos` bucket, in display order (`sort_order`, then primary, then oldest). Each photo includes `created_at`. URLs last one hour (`photo_url_ttl_seconds`). The bucket stays private.
- `listings`: channels currently `listed` in Floor, with `listing_id`, `offer_id`, `url` when Floor can build one, and `ebay_account` (`username`, `role`) for eBay. Both eBay accounts are returned when Floor has a row for each. Website is added from the live storefront.
- `listed_on`: the staff checklist, which can name a channel that has no listing id yet (Mercari often has none).

URLs: eBay `https://www.ebay.com/itm/{id}`, Depop `https://www.depop.com/products/{id}/`, Amazon `https://www.amazon.com/dp/{asin}`, website `https://openboxindustries.com/item/{sku}`. Mercari and Whatnot return the stored id and a null URL.

## Eligible

`eligible` is true only when the unit is available, has a photo, has a Floor price, and is not blocked. `reasons` explains a false flag:

| Reason | Meaning |
| --- | --- |
| `sold` | State is sold, or an unvoided sale exists. |
| `open_sale` | An unvoided sale exists while the unit still says available. |
| `reserved` | Reserved, held by a live reservation, or held by a claimed / unpaid web order. |
| `open_hold` | That hold is still on a unit marked available. |
| `unavailable` | Any other non-sellable state, or quantity on hand is zero. |
| `test` | Test unit. |
| `missing_photo` | No photo row. |
| `missing_price` | Asking price is missing or zero. |
| `photo_unavailable` | A photo row exists but a signed URL could not be issued. |
| `fridge` | Title, brand, model, or category says fridge or refrigerator. |
| `dishwasher` | Says dishwasher. |
| `mattress` | Says mattress or box spring. |
| `scooter` | SKU `11284`, or the text says scooter, hoverboard, m365, or Segway. |

Rugs and carpets are allowed. A blocked unit can still appear in the default feed so the reason is visible; its `eligible` flag is false. Freezers are not on this block list.

## Examples

Feed page:

```json
{
  "ok": true,
  "mode": "feed",
  "view": "available",
  "generated_at": "2026-10-18T03:00:00.000Z",
  "photo_url_ttl_seconds": 3600,
  "limit": 25,
  "count": 1,
  "total": 1,
  "next_cursor": null,
  "units": [
    {
      "sku": "99735",
      "name": "TRINITY Sliding Undersink Organizer",
      "title": "TRINITY Sliding Undersink Organizer",
      "brand": "TRINITY",
      "model": "",
      "upc": null,
      "category": null,
      "condition": "Open box",
      "condition_notes": null,
      "floor_price_cents": 3999,
      "minimum_cents": null,
      "cost_cents": 1200,
      "retail_cents": null,
      "dimensions": {
        "source": "verified",
        "product": { "height_in": null, "width_in": null, "depth_in": null, "weight_lb": null },
        "package": { "length_in": 12, "width_in": 8, "height_in": 6, "weight_lb": 4.5 }
      },
      "quantity": 1,
      "status": "available",
      "created_at": "2026-09-01T00:00:00.000Z",
      "updated_at": "2026-10-01T00:00:00.000Z",
      "listed_on": ["ebay"],
      "listings": [
        {
          "channel": "ebay",
          "status": "listed",
          "listing_id": "820244160755",
          "offer_id": null,
          "url": "https://www.ebay.com/itm/820244160755",
          "listed_at": "2026-10-01T00:00:00.000Z",
          "ebay_account": { "username": "ikonikdeals2026", "role": "selling" }
        }
      ],
      "photos": [
        {
          "url": "https://example.supabase.co/storage/v1/object/sign/unit-photos/...",
          "created_at": "2026-09-02T00:00:00.000Z",
          "sort_order": 0,
          "is_primary": true
        }
      ],
      "available": true,
      "eligible": true,
      "reasons": []
    }
  ]
}
```

Recheck a sold SKU:

```json
{
  "ok": true,
  "mode": "check",
  "available": false,
  "eligible": false,
  "reasons": ["sold"],
  "unit": { "sku": "11548", "status": "sold", "available": false, "eligible": false, "reasons": ["sold"] }
}
```

No key:

```json
{ "ok": false, "error": "unauthorized" }
```
