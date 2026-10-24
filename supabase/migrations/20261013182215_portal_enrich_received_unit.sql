-- Scan-to-list: after receive, merge lookup data into a unit.
-- `units` has no UPDATE policy for authenticated users, so a direct `.from('units').update()`
-- from the admin app affects zero rows. This RPC is the supported path.
--   * listing_specs is merged (new non-null keys win, existing other keys are kept)
--   * brand / model / title / listing_body are only filled when currently blank
--   * msrp_cents is only filled when currently null
--   * show_on_website is only changed when p_show is provided (hold = false)
create or replace function public.portal_enrich_received_unit(
  p_sku text,
  p_specs jsonb default null,
  p_msrp_cents int default null,
  p_show boolean default null,
  p_brand text default null,
  p_model text default null,
  p_title text default null,
  p_description text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_unit public.units;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_specs is not null and jsonb_typeof(p_specs) <> 'object' then
    raise exception 'specs_must_be_object' using errcode = '22023';
  end if;
  if p_msrp_cents is not null and p_msrp_cents < 0 then
    raise exception 'msrp_must_be_non_negative' using errcode = '22023';
  end if;

  select * into v_unit from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;

  update public.units set
    listing_specs = case
      when p_specs is null then listing_specs
      else coalesce(listing_specs, '{}'::jsonb) || jsonb_strip_nulls(p_specs)
    end,
    msrp_cents = coalesce(msrp_cents, p_msrp_cents),
    brand = case when nullif(btrim(coalesce(brand, '')), '') is null then coalesce(nullif(btrim(coalesce(p_brand, '')), ''), brand) else brand end,
    model = case when nullif(btrim(coalesce(model, '')), '') is null then coalesce(nullif(btrim(coalesce(p_model, '')), ''), model) else model end,
    title = case when nullif(btrim(coalesce(title, '')), '') is null then coalesce(nullif(btrim(coalesce(p_title, '')), ''), title) else title end,
    listing_body = case when nullif(btrim(coalesce(listing_body, '')), '') is null then coalesce(nullif(btrim(coalesce(p_description, '')), ''), listing_body) else listing_body end,
    show_on_website = coalesce(p_show, show_on_website),
    updated_at = now()
  where store_id = v_store and sku = p_sku
  returning * into v_unit;

  return jsonb_build_object(
    'sku', v_unit.sku,
    'show_on_website', v_unit.show_on_website,
    'listing_specs', v_unit.listing_specs
  );
end $$;

revoke all on function public.portal_enrich_received_unit(text, jsonb, int, boolean, text, text, text, text) from public, anon;
grant execute on function public.portal_enrich_received_unit(text, jsonb, int, boolean, text, text, text, text) to authenticated;
