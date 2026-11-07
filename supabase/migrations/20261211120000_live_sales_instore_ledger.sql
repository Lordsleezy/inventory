-- In-store register sales must appear in Live Sales even when a sandbox web_order
-- row is (incorrectly) linked on sale_id. sale_ledger used to drop those rows; portal_sales
-- inner-joined the ledger while portal_receipts did not — large POS tickets vanished from Live Sales.

begin;

create or replace function public.sale_channel_is_in_store(p_channel text)
returns boolean
language sql
immutable
parallel safe
as $$
  select lower(btrim(coalesce(p_channel, ''))) = any (
    array['floor', 'store', 'in_store', 'instore']::text[]
  );
$$;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_viewdef('public.sale_ledger'::regclass, false);
  if position('sale_channel_is_in_store' in v_def) > 0 then
    return;
  end if;
  v_new := regexp_replace(
    v_def,
    'where\s+\(\(coalesce\(wo\.payment_env,\s*''production''::text\)\s*<>\s*''sandbox''::text\)\s+and\s+\(lower\(coalesce\(wo\.order_no,\s*''''::text\)\)\s*!~~\s*''sandbox%''::text\)\)\s*;?\s*$',
    'WHERE (public.sale_channel_is_in_store(s.channel) OR ((COALESCE(wo.payment_env, ''production''::text) <> ''sandbox''::text) AND (lower(COALESCE(wo.order_no, ''''::text)) !~~ ''sandbox%''::text)))',
    'in'
  );
  if v_new = v_def then
    raise exception 'sale_ledger sandbox filter not found; manual review needed';
  end if;
  execute 'create or replace view public.sale_ledger as ' || v_new;
end $$;

grant select on public.sale_ledger to authenticated, service_role;

create or replace function public.portal_sales(p_from timestamp with time zone, p_to timestamp with time zone)
returns table (
  id bigint, ticket_key text, sku text, title text, qty integer,
  sold_at timestamp with time zone, price_cents integer, tax_cents integer,
  card_fee_cents integer, cost_cents integer, payment_method text,
  cash_cents integer, card_cents integer, actor_id uuid, actor_name text,
  channel text, receipt_no text, list_price_cents integer,
  override_price_cents integer, override_reason text, override_by_name text,
  ebay_fee_cents integer, baked_ship_cents integer,
  cost_source text, channel_fee_cents integer, fee_source text,
  ship_cost_cents integer, ship_cost_source text,
  processing_fee_cents integer, processing_fee_source text,
  tax_remitted_by text, tax_collected_cents integer, tax_owed_cents integer,
  ask_cents integer, variance_cents integer, profit_cents integer,
  shipping_cents integer
)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  perform public.portal_assert_admin();
  if p_from is null or p_to is null or p_to <= p_from or p_to > p_from + interval '93 days' then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;
  return query
    select s.id, coalesce(s.ticket_id::text, 'sale:' || s.id::text), s.sku,
      coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item')::text,
      s.qty, s.sold_at, s.price_cents, s.tax_cents, s.card_fee_cents,
      l.cost_cents, s.payment_method, x.cash_cents, x.card_cents,
      s.actor_id,
      case
        when not public.sale_channel_is_in_store(s.channel) then 'Online'
        when st.display_name is null or st.display_name in ('Admin', 'service') then 'Unassigned'
        else st.display_name
      end::text,
      s.channel, s.receipt_no,
      s.list_price_cents, s.override_price_cents, s.override_reason,
      coalesce(st_override.display_name, 'Unknown')::text,
      case when lower(s.channel) = 'ebay' then coalesce(l.channel_fee_cents, 0) else 0 end,
      case when lower(s.channel) = 'ebay' then coalesce(l.ship_cost_cents, 0) else 0 end,
      l.cost_source, coalesce(l.channel_fee_cents, 0), l.fee_source,
      coalesce(l.ship_cost_cents, 0), l.ship_cost_source,
      coalesce(l.processing_fee_cents, coalesce(s.processing_fee_cents, 0)),
      coalesce(l.processing_fee_source, s.processing_fee_source),
      l.tax_remitted_by,
      coalesce(l.tax_collected_cents, s.tax_cents),
      coalesce(l.tax_owed_cents, s.tax_cents),
      l.ask_cents, l.variance_cents, l.profit_cents,
      coalesce(l.shipping_cents, s.shipping_cents, 0)
    from public.sales s
    left join public.sale_ledger l on l.id = s.id
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
    left join public.staff st_override on st_override.store_id = s.store_id and st_override.user_id = s.override_by
    left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
    where s.store_id = v_store and s.voided_at is null and s.sold_at >= p_from and s.sold_at < p_to
    order by s.sold_at desc, s.id desc;
end $function$;

commit;
