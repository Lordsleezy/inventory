-- Read-only reporting role for Metabase (Legion host). Apply after 0025.
-- Connect Metabase with this role only — never the service role.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'floor_reporting') then
    create role floor_reporting nologin;
  end if;
end;
$$;

-- Password set out-of-band: ALTER ROLE floor_reporting PASSWORD '...';

grant usage on schema public to floor_reporting;
grant select on
  public.stores,
  public.sales,
  public.units,
  public.units_pos,
  public.sale_receipts,
  public.staff,
  public.listings,
  public.delist_tasks,
  public.events,
  public.incidents,
  public.store_settings
to floor_reporting;

-- Views for CDTFA-ish tax rollups (Metabase can also query raw sales).
create or replace view public.report_sales_by_day
with (security_invoker = true) as
select
  store_id,
  (sold_at at time zone 'America/Los_Angeles')::date as sale_day,
  count(*)::int as line_count,
  sum(price_cents)::bigint as merchandise_cents,
  sum(coalesce(tax_cents, 0))::bigint as tax_cents,
  sum(price_cents + coalesce(tax_cents, 0))::bigint as total_cents
from public.sales
where voided_at is null
group by 1, 2;

create or replace view public.report_inventory_aging
with (security_invoker = true) as
select
  store_id,
  sku,
  state,
  condition,
  ask_cents,
  received_at,
  greatest(0, floor(extract(epoch from (now() - received_at)) / 86400))::int as age_days
from public.units
where state in ('available', 'reserved', 'repair');

grant select on public.report_sales_by_day, public.report_inventory_aging to floor_reporting;
