begin;

alter table public.portal_expenses drop constraint if exists portal_expenses_amount_cents_check;
alter table public.portal_expenses add constraint portal_expenses_amount_cents_check check (amount_cents >= 0);

-- Keep publisher readiness precise: a chosen category with taxonomy conflicts or
-- stale required fields is still unfinished, but it is not a missing category.
create or replace function public.unit_listing_gaps(u public.units)
returns text[] language sql stable set search_path=public as $$
  with f as (
    select public.unit_not_for_sale(u.listing_specs) as nfs,
      public.floor_unit_ebay_gaps(u.store_id,u.sku) as eg,
      exists(select 1 from public.unit_channel_categories c where c.store_id=u.store_id
        and c.sku=u.sku and c.channel='ebay' and c.category_id is not null and c.enabled) as has_category,
      exists(select 1 from public.unit_channel_categories c where c.store_id=u.store_id
        and c.sku=u.sku and c.channel='ebay' and c.category_id is not null and c.enabled
        and c.review_reason is not null) as needs_category_review
  )
  select case when public.unit_dns(u.listing_specs) then '{}'::text[] else array_remove(array[
    case when nullif(btrim(coalesce(u.brand,'')),'') is null
      or u.brand ~* '^(generic|unknown|n/?a|does not apply)$' then 'brand' end,
    case when not f.nfs and not f.has_category
      and nullif(btrim(coalesce(u.category,'')),'') is null
      and nullif(btrim(coalesce(u.ebay_category,'')),'') is null
      and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id','')),'') is null then 'category' end,
    case when not f.nfs and 'category'=any(f.eg) and f.has_category then 'category_review' end,
    case when not f.nfs and 'specifics'=any(f.eg) then 'specifics' end,
    case when not f.nfs and (coalesce(u.package_weight_lb,0)<=0 or coalesce(u.package_length_in,0)<=0
      or coalesce(u.package_width_in,0)<=0 or coalesce(u.package_height_in,0)<=0) then 'spec' end,
    case when not f.nfs and not public.floor_valid_upc(u.upc) and exists(
      select 1 from public.unit_channel_selections s where s.store_id=u.store_id and s.sku=u.sku
        and s.selected and s.channel in ('amazon','tiktok')) then 'upc' end,
    case when not f.nfs and not exists(select 1 from public.photos p where p.store_id=u.store_id and p.sku=u.sku) then 'photo' end,
    case when not f.nfs and u.ask_cents is null then 'price' end,
    case when not f.nfs and nullif(btrim(coalesce(u.title,'')),'') is null then 'title' end,
    case when not f.nfs and nullif(btrim(coalesce(u.condition,'')),'') is null then 'condition' end,
    case when not f.nfs and nullif(btrim(coalesce(u.model,'')),'') is null then 'model' end,
    case when not f.nfs and nullif(btrim(coalesce(u.listing_body,'')),'') is null then 'description' end,
    case when not f.nfs and u.listing_specs->>'ebay_review_reason' in
      ('review_hygiene','review_supplement','review_quantity','review_contents','review_bundle',
       'review_stove','review_product','review_condition','review_cosmetic') then u.listing_specs->>'ebay_review_reason' end
  ],null) end from f;
$$;
revoke all on function public.unit_listing_gaps(public.units) from public,anon,authenticated;

create or replace function public.unit_is_unfinished(p_gaps text[])
returns boolean language sql immutable set search_path=public as $$
  select coalesce(p_gaps,'{}') && array[
    'photo','price','brand','condition','category','category_review','upc','model','title','description','specifics',
    'review_hygiene','review_supplement','review_quantity','review_contents','review_bundle',
    'review_stove','review_product','review_condition','review_cosmetic'
  ];
$$;

-- Existing disposition RPCs already validate admin access, store ownership,
-- payout state, and Books locks. Expand their eligible source states to all
-- unsold inventory, including reserved and repair/Defective units.
do $$
declare f record; src text; changed text;
begin
  for f in select p.oid,p.proname,p.prosrc,n.nspname from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('portal_record_replacement','portal_record_giveaway')
  loop
    src:=pg_get_functiondef(f.oid);
    changed:=replace(src,'if u.state <> ''available'' then raise exception ''unit_not_available''; end if;',
      'if u.state not in (''available'',''reserved'',''repair'') then raise exception ''unit_not_available''; end if;');
    if changed=src then raise exception 'Could not update unsold eligibility for %',f.proname; end if;
    execute changed;
  end loop;
end $$;

-- A giveaway with unknown acquisition cost remains a $0 expense row with an
-- explicit note. The existing cost-change trigger updates it when real cost is entered.
create or replace function public.giveaway_sync_expense(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare d public.unit_dispositions; u public.units; v_cost int; v_exp uuid; v_desc text;
begin
  select * into d from public.unit_dispositions where id=p_id;
  if not found or d.kind<>'giveaway' then return; end if;
  select * into u from public.units where store_id=d.store_id and sku=d.sku;
  v_cost:=public.disposition_unit_cost(d.store_id,d.sku);
  v_desc:=format('Giveaway · %s (SKU %s) → %s%s · by %s%s',
    coalesce(nullif(btrim(concat_ws(' ',u.brand,u.model)),''),nullif(u.title,''),'Item'),d.sku,d.given_to,
    case when nullif(btrim(coalesce(d.note,'')),'') is null then '' else ' — '||d.note end,
    coalesce(d.recorded_by_name,'admin'),case when v_cost is null then ' · cost missing; $0 recorded' else '' end);
  v_exp:=d.expense_id;
  if d.undone_at is not null then
    if v_exp is not null then update public.portal_expenses set voided_at=coalesce(voided_at,now()),void_reason='Giveaway undone'
      where id=v_exp and voided_at is null; end if;
    return;
  end if;
  if v_exp is null then
    insert into public.portal_expenses(store_id,spent_on,description,category,amount_cents,needs_reimbursement,source,created_by,external_id)
    values(d.store_id,(d.created_at at time zone 'America/Los_Angeles')::date,v_desc,'Giveaways',coalesce(v_cost,0),false,'giveaway',d.recorded_by,d.id::text)
    returning id into v_exp;
    update public.unit_dispositions set expense_id=v_exp where id=d.id;
  else
    update public.portal_expenses set amount_cents=coalesce(v_cost,0),description=v_desc,voided_at=null,void_reason=null where id=v_exp;
  end if;
end $$;
revoke all on function public.giveaway_sync_expense(uuid) from public,anon,authenticated;
grant execute on function public.giveaway_sync_expense(uuid) to service_role;

commit;
