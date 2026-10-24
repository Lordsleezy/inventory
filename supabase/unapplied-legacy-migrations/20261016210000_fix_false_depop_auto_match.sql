-- Undo the price-only auto-match that sold puzzle 99096 as the Depop measuring-cups order,
-- remove the Lasko Fan pipeline test from Orders, and label the two real unmatched Depop sales.

update public.sales
  set voided_at = coalesce(voided_at, now()),
      void_reason = coalesce(void_reason, 'False auto-match: Depop measuring-cups sale wrongly linked to puzzle 99096')
where id = 83 and voided_at is null;

update public.units
  set state = 'available', updated_at = now()
where sku = '99096' and state = 'sold';

delete from public.web_order_emails
where order_id in (
  'bdb83992-4be9-4f98-8c72-41fb8a7bb26c',
  'eace96da-fdd8-4060-9ef5-da9e347ed362'
);

delete from public.web_orders
where id in (
  'bdb83992-4be9-4f98-8c72-41fb8a7bb26c',
  'eace96da-fdd8-4060-9ef5-da9e347ed362'
);

update public.web_orders
  set marketplace_title = 'Measuring cup set',
      buyer_name = coalesce(nullif(btrim(buyer_name), ''), '@kwfastkat1988'),
      match_status = 'unmatched',
      sku = 'UNMATCHED',
      sale_id = null,
      updated_at = now()
where id = '5b6e8ff9-0ae2-4004-af70-9baaa4abe258';

update public.web_orders
  set marketplace_title = 'Diapers',
      buyer_name = coalesce(nullif(btrim(buyer_name), ''), '@f102z'),
      match_status = 'unmatched',
      sku = 'UNMATCHED',
      sale_id = null,
      updated_at = now()
where id = '8e94bb52-317b-49c4-bf13-4e4b05ff2c68';

-- Tighten SKU suggestions: price alone never qualifies (need a title/brand/model token).
create or replace function public.portal_suggest_order_skus(p_order uuid, p_limit int default 5)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_store uuid := public.portal_store_id();
  v_order public.web_orders;
  v_title text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  select * into v_order from public.web_orders where id = p_order and store_id = v_store;
  if not found then raise exception 'order_not_found' using errcode='P0002'; end if;
  v_title := lower(coalesce(nullif(btrim(v_order.marketplace_title), ''), ''));
  return coalesce((
    select jsonb_agg(to_jsonb(x) - 'title_hits' order by x.score desc, x.sku)
    from (
      select u.sku,
             coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), u.sku) as title,
             u.ask_cents,
             coalesce((
               select sum(case when length(w) > 4 then 2 else 1 end)
               from unnest(regexp_split_to_array(regexp_replace(v_title, '[^a-z0-9\s]', ' ', 'g'), '\s+')) w
               where length(w) > 2
                 and w not in ('the','and','for','with','pack','open','box','sale','depop','mercari','your','usps','shipping','label','confirmation','needs','match')
                 and strpos(lower(coalesce(u.title,'') || ' ' || coalesce(u.brand,'') || ' ' || coalesce(u.model,'')), w) > 0
             ), 0)::int as title_hits,
             (
               case when u.ask_cents is not null and v_order.item_cents > 0 and u.ask_cents = v_order.item_cents then 5
                    when u.ask_cents is not null and v_order.item_cents > 0 and abs(u.ask_cents - v_order.item_cents) <= 100 then 3
                    when u.ask_cents is not null and v_order.item_cents > 0 and abs(u.ask_cents - v_order.item_cents) <= 500 then 1
                    else 0 end
               + coalesce((
                   select sum(case when length(w) > 4 then 2 else 1 end)
                   from unnest(regexp_split_to_array(regexp_replace(v_title, '[^a-z0-9\s]', ' ', 'g'), '\s+')) w
                   where length(w) > 2
                     and w not in ('the','and','for','with','pack','open','box','sale','depop','mercari','your','usps','shipping','label','confirmation','needs','match')
                     and strpos(lower(coalesce(u.title,'') || ' ' || coalesce(u.brand,'') || ' ' || coalesce(u.model,'')), w) > 0
                 ), 0)
             )::int as score
      from public.units u
      where u.store_id = v_store
        and u.state = 'available'
        and (
          v_order.channel = any(coalesce(u.listed_on, '{}'::text[]))
          or coalesce(cardinality(u.listed_on), 0) = 0
        )
    ) x
    where x.title_hits > 0 and x.score > 0
    order by x.score desc, x.sku
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ), '[]'::jsonb);
end $$;
revoke all on function public.portal_suggest_order_skus(uuid, int) from public, anon;
grant execute on function public.portal_suggest_order_skus(uuid, int) to authenticated;
