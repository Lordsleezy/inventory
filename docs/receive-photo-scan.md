# Photo Receive source lookups

Photo identification is frozen: the identifyFrames receive prompt/model and ReceivePanel identification field assignment are unchanged.

## Lookup behavior

- Price: UPCitemdb recorded merchant offers, then Sentinel Prime eBay Browse active listings (GTIN, then identity keywords), then one Google-grounded Gemini search. Sources are separate requests; an error does not become an empty result. The selling price input is exclusively staff controlled.
- Match brand/product line, printed size, manufacturer model where present, and whole-package count. Merchant offer titles override generic UPC titles for matching. Non-USD offers are excluded. UPC redirect hosts do not collapse distinct merchants.
- Dimensions: Amazon Catalog item/package measurements, then UPCitemdb fills missing fields, then saved Floor measurements fill gaps. Each response updates the screen. Staff edits and reviewed mat values survive late responses. Known identity/size/count mismatches are rejected. No carton padding or weight multipliers.
- Logging: floor_logs events receive_photo.price_source, receive_photo.retail_fail, receive_photo.dimension_sources, receive_photo.dimensions_failed. Detail includes timing, outcome/count or per-field source. UPC responses have a short, bounded warm-function cache; Gemini retains the existing database cache. Catalog/Browse hits incur no Gemini search cost.

## Environment (inventoryobi, production, Functions scope)

Existing: EBAY_CLIENT_ID + EBAY_CLIENT_SECRET (Sentinel Prime), EBAY_ENV=production, GEMINI_API_KEY, AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_SELLER_ID, CONNECTIONS_KEY and the existing authorized Amazon connection. Keep existing identification model settings unchanged.

Optional paid capacity: UPCITEMDB_KEY. Without it UPCitemdb uses the trial endpoint and may hit its shared daily quota. No new schema migration is required.

## Measuring mat

The public asset /floor-aruco-mat.pdf is US Letter, 100% actual size, DICT_4X4_50 markers 0-3, each 1.50 inches. Regenerate with scripts/generate-receive-mat.py (OpenCV contrib + reportlab). The browser loads OpenCV only when Measure on mat is chosen. It identifies four markers and rectifies perspective; staff tap opposite item corners in the top photo, then bottom/top in a side photo with the mat upright and coplanar. Review/edit inches before applying to product or actual package. Weight always requires catalog data or a scale.

This is assisted edge selection, not automatic object segmentation. A raised object, poor camera angle, wrong print scale, hidden markers or non-coplanar side image can reduce accuracy. Verify shipping measurements with a ruler. No physical iPhone/printer accuracy certification has been performed.

## Verification

Run node --test netlify/lib/receive-price.test.mjs netlify/lib/receive-dimensions.test.mjs netlify/lib/upc-lookup.test.mjs and the admin build. The existing video-scan identity retry test expects an old 1400-token/retry behavior, while frozen identification currently uses 1700 tokens and one attempt; do not change identification to satisfy that obsolete assertion.
