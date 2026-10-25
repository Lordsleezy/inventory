-- A barcode is required for Amazon/TikTok only. eBay readiness must not inherit another channel's UPC gap.
begin;
create or replace function public.floor_valid_upc(p_code text)
returns boolean language plpgsql immutable set search_path=public as $$
declare v text:=btrim(coalesce(p_code,'')); n int; total int:=0; i int;
begin
 n:=length(v); if n not in (8,12,13,14) or v !~ '^[0-9]+$' or v ~ '^0+$' then return false; end if;
 for i in 1..n loop total:=total+substring(v,n-i+1,1)::int * case when i%2=0 then 3 else 1 end; end loop;
 return total%10=0;
end $$;
revoke all on function public.floor_valid_upc(text) from public,anon;
grant execute on function public.floor_valid_upc(text) to authenticated,service_role;

create or replace function public.unit_listing_gaps(u public.units)
returns text[] language sql stable set search_path = public as $$
  with f as (
    select public.unit_not_for_sale(u.listing_specs) as nfs,
      public.floor_unit_ebay_gaps(u.store_id, u.sku) as eg,
      exists (select 1 from public.unit_channel_categories c
        where c.store_id = u.store_id and c.sku = u.sku and c.channel = 'ebay'
          and c.category_id is not null and c.enabled) as has_category
  )
  select array_remove(array[
    case when nullif(btrim(coalesce(u.brand, '')), '') is null
           or u.brand ~* '^(generic|unknown|n/?a|does not apply)$' then 'brand' end,
    case when not f.nfs and ((nullif(btrim(coalesce(u.category, '')), '') is null
           and nullif(btrim(coalesce(u.ebay_category, '')), '') is null
           and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id', '')), '') is null
           and not f.has_category) or 'category' = any(f.eg)) then 'category' end,
    case when not f.nfs and 'specifics' = any(f.eg) then 'specifics' end,
    case when not f.nfs and (coalesce(u.package_weight_lb, 0) <= 0 or coalesce(u.package_length_in, 0) <= 0
           or coalesce(u.package_width_in, 0) <= 0 or coalesce(u.package_height_in, 0) <= 0) then 'spec' end,
    case when not f.nfs and not public.floor_valid_upc(u.upc) and exists (
           select 1 from public.unit_channel_selections s where s.store_id=u.store_id and s.sku=u.sku
             and s.selected and s.channel in ('amazon','tiktok')) then 'upc' end,
    case when not f.nfs and not exists (
           select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku) then 'photo' end,
    case when not f.nfs and u.ask_cents is null then 'price' end,
    case when not f.nfs and nullif(btrim(coalesce(u.title, '')), '') is null then 'title' end,
    case when not f.nfs and nullif(btrim(coalesce(u.condition, '')), '') is null then 'condition' end,
    case when not f.nfs and nullif(btrim(coalesce(u.model, '')), '') is null then 'model' end,
    case when not f.nfs and nullif(btrim(coalesce(u.listing_body, '')), '') is null then 'description' end,
    case when not f.nfs and u.listing_specs->>'ebay_review_reason' in (
      'review_hygiene', 'review_supplement', 'review_quantity', 'review_contents',
      'review_bundle', 'review_stove', 'review_product', 'review_condition', 'review_cosmetic'
    ) then u.listing_specs->>'ebay_review_reason' end
  ], null)
  from f;
$$;
revoke all on function public.unit_listing_gaps(public.units) from public, anon, authenticated;

create or replace function public.floor_unit_channel_mandatory_gaps(p_store uuid,p_sku text,p_channel text)
returns text[] language sql stable security definer set search_path=public as $$
 select array_remove(public.floor_unit_mandatory_gaps(p_store,p_sku),'upc') ||
   case when p_channel in ('amazon','tiktok') and not public.floor_valid_upc(u.upc) then array['upc'] else '{}'::text[] end
 from public.units u where u.store_id=p_store and u.sku=p_sku;
$$;
revoke all on function public.floor_unit_channel_mandatory_gaps(uuid,text,text) from public,anon,authenticated;
grant execute on function public.floor_unit_channel_mandatory_gaps(uuid,text,text) to service_role;

create or replace function public.portal_set_unit_channel_selection(p_sku text, p_channel text, p_selected boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_assert_admin_store();
  v_reason text;
  v_live boolean;
  v_action text;
begin
  if p_channel is null or p_channel not in ('ebay','amazon','tiktok') or p_selected is null then
    raise exception 'invalid_channel' using errcode = '22023';
  end if;
  if not exists (select 1 from public.units where store_id = v_store and sku = p_sku) then
    raise exception 'unit_not_found' using errcode = '22023';
  end if;
  if p_selected then
    if p_channel in ('amazon','tiktok') and not exists (select 1 from public.units u
      where u.store_id=v_store and u.sku=p_sku and public.floor_valid_upc(u.upc)) then
      raise exception 'channel_upc_required: Add a valid UPC before selecting Amazon or TikTok Shop' using errcode='22023';
    end if;
    v_reason := public.floor_unit_never_list_reason(v_store, p_sku, p_channel);
    if v_reason is not null then
      raise exception 'channel_never_list: %', v_reason using errcode = '22023';
    end if;
  end if;
  insert into public.unit_channel_selections (store_id, sku, channel, selected, source, updated_by, updated_at)
  values (v_store, p_sku, p_channel, p_selected, 'admin', auth.uid(), now())
  on conflict (store_id, sku, channel) do update
    set selected = excluded.selected, source = 'admin', updated_by = excluded.updated_by, updated_at = now();
  if p_selected then
    insert into public.unit_channel_categories (store_id, sku, channel, enabled, source, updated_at)
    values (v_store, p_sku, p_channel, true, 'manual', now())
    on conflict (store_id, sku, channel) do update set enabled = true, updated_at = now();
  end if;

  v_live := public.floor_unit_live_on(v_store, p_sku, p_channel);
  delete from public.listing_queue
   where store_id = v_store and sku = p_sku and channel = p_channel and status in ('queued','failed');
  v_action := case when p_selected and not v_live then 'list' when not p_selected and v_live then 'end' end;
  if v_action is not null then
    insert into public.listing_queue (store_id, sku, channel, action, created_by)
    values (v_store, p_sku, p_channel, v_action, auth.uid())
    on conflict do nothing;
  end if;
  return jsonb_build_object('sku', p_sku, 'channel', p_channel, 'selected', p_selected,
    'live', v_live, 'queued', v_action);
end $$;
revoke all on function public.portal_set_unit_channel_selection(text,text,boolean) from public, anon;
grant execute on function public.portal_set_unit_channel_selection(text,text,boolean) to authenticated;

create or replace function public.portal_unit_channel_selections(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  return (select jsonb_object_agg(c.ch, jsonb_build_object(
      'selected', coalesce(s.selected, false),
      'blocked_reason', case when c.ch in ('amazon','tiktok') and not exists (select 1 from public.units u
          where u.store_id=v_store and u.sku=p_sku and public.floor_valid_upc(u.upc)) then 'UPC required' end,
      'live', public.floor_unit_live_on(v_store, p_sku, c.ch),
      'never_reason', public.floor_unit_never_list_reason(v_store, p_sku, c.ch),
      'queue', (select jsonb_build_object('action', q.action, 'status', q.status, 'issue', q.issue, 'last_error', q.last_error)
                from public.listing_queue q where q.store_id = v_store and q.sku = p_sku and q.channel = c.ch
                  and q.status in ('queued','working','failed') limit 1)))
    from unnest(array['ebay','amazon','tiktok']) c(ch)
    left join public.unit_channel_selections s on s.store_id = v_store and s.sku = p_sku and s.channel = c.ch);
end $$;
revoke all on function public.portal_unit_channel_selections(text) from public, anon;
grant execute on function public.portal_unit_channel_selections(text) to authenticated;
commit;
