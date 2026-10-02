# Production online orders

Deploy the migration `supabase/migrations/20261002200000_online_orders.sql` to the **floor** Supabase project before deploying the new Floor functions. It is transaction-wrapped and safe to rerun. It repairs the shipping claim status, freezes the quote, records the sale and packing row atomically, includes shipping in ticket totals, and queues order/tracking emails. Apply only this new migration when earlier migrations are already installed.

## Netlify environment variables

Set these in **inventoryobi → Project configuration → Environment variables**, Production context, Functions scope (or All scopes), then redeploy:

| Variable | Value/source |
|---|---|
| `SQUARE_WEB_APPLICATION_ID` | Square Developer Console, signed into **Open Box Industries** → select application → **Production** → **Credentials** → Application ID |
| `SQUARE_WEB_ACCESS_TOKEN` | Same screen → **Production Access token → Show**. Server secret; never a `NEXT_PUBLIC_` or `VITE_` value. |
| `SQUARE_WEB_LOCATION_ID` | Same application, **Production → Locations** → the active Open Box Industries location ID |
| `SQUARE_WEB_STORE_ID` | `5487ca47-6147-4fe8-bc6d-46b6472726ba` |
| `STORE_WEB_KEY` | A random server secret; identical on inventoryobi and the storefront. Existing `STORE_WEB_REWARDS_KEY` works if `STORE_WEB_KEY` is absent on both. |
| `RESEND_API_KEY` | Resend → API Keys → key allowed to send from your verified domain |
| `RESEND_FROM` | Sender on that verified domain, e.g. `Open Box Industries <orders@your-verified-domain>` |
| `FLOOR_OWNER_EMAIL` | Your inbox for new-order notifications |

Keep existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE` on inventoryobi. No register OAuth, application secret, or sandbox credentials are used by website charges or automatic failure refunds.

On the **openbox-store-web** Netlify project, set `STORE_WEB_KEY` to the same value, and `FLOOR_FUNCTIONS_URL=https://inventoryobi.netlify.app`. Keep the existing `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_STORE_ID`. Use Production / All scopes, then redeploy; Square credentials do not belong on this site.

Square docs: https://developer.squareup.com/docs/build-basics/access-tokens and https://developer.squareup.com/docs/devtools/developer-dashboard

## Small live test and refund

1. Install the new POS release and TestFlight build. On POS → Inventory, create a disposable test unit with quantity 1, price **$2**, floor at most $2, a photo, weight **1 lb**, **Shippable** and **List online** checked. Set **Shipping override = $0**. Blank would charge the normal $20 tier.
2. Open its live website listing and click Buy. Use your real name/address, your buyer-test email and phone; disable rewards credit for this test. Confirm the final total is between $1 and $5. Use a real card; production does not accept Square sandbox cards.
3. Submit once. Verify the exact amount in the **Open Box Industries production Square Dashboard → Transactions**, the owner email, and the buyer confirmation. Refreshing/retrying the same order must not create a second payment.
4. Phone → Shipments → **New → Boxed → Awaiting Shipping**. Enter `TEST-NOT-A-REAL-SHIPMENT` as tracking for this disposable test, then **Shipped**. Verify **Past** and the buyer tracking email. No carrier label or shipment is purchased by this action.
5. Square Dashboard → **Transactions → select that payment → ⋯ → Issue refund → full amount → reason “Website checkout test” → Issue Refund**. Square keeps its processing fee. Refund arrival can take 4–14 business days. https://my.squareup.com/help/us/en/article/6116
6. Uncheck **List online** for the test SKU. A manual Square Dashboard refund does not automatically void/restock the Floor sale; leave the disposable test unit sold, or separately void it in Floor if you want your test sale removed from reports. Never charge/refund twice.

## Delivery/recovery checks

`web-order-email` and `web-order-reconcile` run every five minutes on the production Floor deploy. The first retries unsent owner, confirmation and tracking messages; the second resolves interrupted payment attempts with the same Square idempotency key. Resend acceptance is tracked, not inbox delivery. Check Resend Logs for delivered/bounced status. Unsent mail and its latest error remain in `web_order_emails`; do not paste its buyer data into public logs.

Tests: `node scripts/test-online-orders.mjs` and `node --test netlify/lib/web-payment.test.mjs`. Local frontend builds do not prove live Square credentials or actual email delivery; complete the live test above after configuration.
