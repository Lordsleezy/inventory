# eBay real fees

For eBay sales Floor never does its own fee math. Every fee comes from the eBay Sell Finances API
(`getTransactions`); if Floor disagrees with the order earnings page in Seller Hub, Floor is wrong.

## Data flow

| eBay Finances transaction | What Floor stores |
|---|---|
| `SALE` | each `marketplaceFees` entry by `feeType` (final value fee, fixed per-order fee, `AD_FEE`, international, regulatory, ...), the sale date, the net, eBay-collected tax. Any gap between the itemized fees and eBay's `totalFeeAmount` is stored as `OTHER_FEES`. |
| `NON_SALE_CHARGE` (`AD_FEE`, `PREMIUM_AD_FEES`, others) | matched to its order by order ID (field or `ORDER_ID` reference) and stored on that order. Charges eBay does not tie to an order (campaign charges) are stored with no order and booked once as an eBay overhead expense keyed by eBay's transaction ID. |
| `SHIPPING_LABEL` | debits/credits per order; the label cost on the order (wrong label replaced, credit not posted yet: latest debit wins). |

* Table `ebay_order_fees`: one row per charge and fee type (`txn_id`, `fee_type`, signed `amount_cents`). Admin-read only.
* `channel_orders.fee_cents` is the sum of those rows (except `SHIPPING_LABEL`, which is `ship_label_cents`).
  `channel_orders.ad_fee_cents` is the ad part. The ledger (`sale_ledger`) reads `fee_cents`.
* The estimated eBay fee is gone: `channel_fee_estimate()` returns no rate for eBay, order ingest stores no fee,
  and `ebayFeeCents()` was deleted. A sale with no stored fee shows fee 0, source `none`.
* Sync: `netlify/lib/ebay-fees.mjs`, called at the end of the existing `ebay-sync` run (every 3 minutes). It makes no
  eBay call unless an eBay order is still waiting on fees, plus one full 90-day reconcile sweep every 6 hours.
  No new scheduled function. `channel-fee-sync` is now Square-only.

## Commission hold

An eBay sale's commission does not freeze until its fees are final:

1. The sale is frozen immediately but with no commission base (`sale_payout_lines.fees_pending = true`); every person's
   amount is `null`, shown as **Waiting on eBay fees**.
2. Fees are final when eBay's `SALE` transaction is in Finances **and** `ebay_fee_grace_hours` (store setting, default
   **72**) have passed since that transaction, so late ad charges are included. `ebay_fee_settle_due()` then fills the
   line once from the ledger and computes the ticket (`channel_orders.fees_settled_at`).
3. Overrides, returns, replacements and the no-cost rule work as before: an override applies once the real base exists,
   a missing cost still holds the commission, returns/replacements read the frozen amounts.
4. A charge that arrives after the commission froze updates the ledger/reports but not the frozen commission
   (an owner can re-freeze one sale from Payouts).

## History script

`scripts/ebay-fee-history.mjs --store <uuid>` (dry run) / `--apply`. Re-pulls real fees for every past eBay sale and
writes `reports/ebay-fee-history-*.csv` (old fee vs real fee, ad fee, profit change, commission change per person) plus
`.paid-out.txt`. Unpaid sales are re-based; any sale with commission already paid out is never touched and is listed with
dollar amounts. "Paid" = per person, payments (less reimbursements) applied oldest sale first.
