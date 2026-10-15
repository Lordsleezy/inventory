# eBay multi-account + listing migration

Floor can hold more than one eBay OAuth connection per store.

| Role | Purpose |
|---|---|
| `selling` | Store business account. New listings, auto-delist, primary order/fee ingest. |
| `orders_only` | Personal seller (`pgg124-5`) during cutover. Sync sales/fees only; never create or end listings. |

## Operator sequence

1. Deploy this change (functions + admin) via `scripts/deploy-prod-netlify.mjs`.
2. Apply Supabase migration `20261025150000_ebay_multi_account.sql`.
3. In Admin → Marketplaces:
   - Keep **Connect pgg124-5 (orders only)** connected (backfill may already have it).
   - **Connect selling account** while logged into the business eBay account in the browser.
   - **Create business policies** (Calculated Shipping – Buyer Pays, No Returns – As Is, Payments).
4. **Dry-run migration** — review will_move / skipped / failed.
5. **Run migration** — ends each listing on source, recreates on dest at the same price, updates Floor.
6. Point Vendoo (if still used) at the business account; stop creating new listings on pgg124-5.
7. When pgg124-5 has no open store orders left, Disconnect that orders-only account.
8. Optionally set Netlify `EBAY_ORDERS_ONLY=false` so legacy code paths also treat eBay as listing-capable.

## Safety rules

- Never dual-live: EndItem on source before AddFixedPriceItem on dest.
- Skip open orders, bids, best offers, refrigerators/dishwashers/mattresses, prohibited goods.
- Never cancel or refund eBay orders.
- Pace live moves ~4–9 seconds apart.
