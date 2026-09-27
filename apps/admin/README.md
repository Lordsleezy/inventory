# Floor Admin portal

Browser admin for Open Box Industries. This is a separate npm workspace and Netlify site; the existing `inventoryobi.netlify.app` functions site, register, mobile app, and Codemagic configuration are unchanged.

## Database setup

Apply `supabase/migrations/20260927120000_admin_portal.sql` to the **floor** project after the earlier migrations. The migration adds portal-only membership, reports, payout settings and paid records, an admin-checked sales function, and a SELECT policy/publication entry for sales Realtime.

In Supabase Authentication → Users, create the two email/password users and confirm their email addresses. The portal has no sign-up page. Its membership list gates all portal data independently of the project's other Auth flows; leave Floor's existing signup settings alone.

Find the correct store ID with:

```sql
select id from public.stores;
```

Then replace the values below and run this in the SQL Editor:

```sql
insert into public.portal_admins (user_id, store_id)
select id, '<STORE_ID>'::uuid
from auth.users
where lower(email) in ('you@example.com', 'owner@example.com')
on conflict (user_id) do update set store_id = excluded.store_id;

select u.email, a.store_id
from public.portal_admins a join auth.users u on u.id = a.user_id
where a.store_id = '<STORE_ID>'::uuid;
```

Verify the final query shows exactly the intended two accounts. Both have identical portal permissions. Remove access by deleting that user's `portal_admins` row using the SQL Editor. Do not put a service role key in the website.

## Netlify

Create a **new** Netlify site from `Lordsleezy/inventory`, branch `master`. Leave the base directory at the repo root, and set the **package directory** to `apps/admin`. Netlify will then find [netlify.toml](./netlify.toml), which builds the admin workspace and publishes `apps/admin/dist`. Keep the current Floor functions site as its own site.

Set these environment variables on the new site, using the same public values already used by Floor:

- `VITE_SUPABASE_URL=https://zoukmsmbztcuyoslvikp.supabase.co`
- `VITE_SUPABASE_ANON_KEY=<floor project anon/publishable key>`

The build fails if either value is missing. No Supabase service role key or Netlify function is needed for this site. Choose `openbox-floor-admin` as the Netlify site name if available. In Netlify, add `admin.openboxindustries.com` as its custom domain.

In Cloudflare DNS, add a **CNAME** record: **Name** `admin`, **Target** `openbox-floor-admin.netlify.app` (or the actual new site's `.netlify.app` hostname), **Proxy status** DNS only, **TTL** Auto. The target must be the *new admin site*, not `inventoryobi.netlify.app`. Let Netlify provision HTTPS after DNS resolves.

## Amounts

Sales and payouts are based on non-voided `public.sales` rows. Ticket lines count as one transaction. The store day and week use America/Los_Angeles time; weeks start Monday. Sales and profit percentages use merchandise revenue before tax and card fees. Profit subtracts `units.acquisition_cost_cents × qty`; an unknown cost blocks a profit payout for that ticket. A flat cut applies once per ticket. Paid amounts are saved at payment time.

Historical cost is read from the current `units` row because Floor does not snapshot cost on the sale. Changing a unit's cost can change an unpaid historical profit estimate. Historical sales before the card fee column was introduced show zero fee; legacy sales without `ticket_extras` may lack cash/card split detail. Sales with no `actor_id` cannot be assigned an employee payout. Submitted reports retain their sales snapshot while expense and note edits update the editor and timestamp.
