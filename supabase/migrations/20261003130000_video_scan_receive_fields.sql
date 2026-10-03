begin;

create or replace function public.video_scan_receive(p_id uuid,p_draft jsonb,p_ask_cents int)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.video_scan_store_id(); v_job public.video_scan_jobs; v_sku text;
  v_json jsonb; v_unit public.units; v_msrp int; v_title text; v_cost int; v_floor int;
begin
  if v_store is null then raise exception 'scan_access_denied' using errcode='42501'; end if;
  if p_ask_cents is null or p_ask_cents<=0 then raise exception 'selling_price_required' using errcode='22023'; end if;
  select * into v_job from public.video_scan_jobs where id=p_id and store_id=v_store and created_by=auth.uid() for update;
  if not found then raise exception 'scan_not_found' using errcode='P0001'; end if;
  if v_job.status='saved' then return jsonb_build_object('sku',v_job.sku); end if;
  if v_job.status<>'ready' then raise exception 'scan_not_ready' using errcode='P0001'; end if;
  if jsonb_typeof(p_draft)<>'object' then raise exception 'invalid_draft' using errcode='22023'; end if;
  v_title:=left(coalesce(p_draft->>'title',''),240);
  v_msrp:=nullif(p_draft->>'msrp_cents','')::int;
  v_cost:=nullif(p_draft->>'acquisition_cost_cents','')::int;
  v_floor:=nullif(p_draft->>'floor_cents','')::int;
  if v_msrp<0 or v_cost<0 or v_floor<0 then raise exception 'negative_amount' using errcode='22023'; end if;
  if public.portal_store_id()=v_store then
    v_json:=public.portal_receive_unit(1,coalesce(p_draft->>'brand',''),coalesce(p_draft->>'model',''),v_title,
      p_draft->>'category',p_draft->>'condition',p_draft->>'test_status',p_draft->>'location',
      p_ask_cents,v_msrp,v_cost,v_floor,p_draft->>'condition_notes',p_draft->>'upc',p_draft->>'lot',p_draft->>'mfr_serial');
    v_sku:=v_json->'skus'->>0;
  else
    perform pg_advisory_xact_lock(687593,hashtext(v_store::text));
    v_sku:=public.next_sku();
    v_unit:=public.receive_unit(v_sku,coalesce(p_draft->>'brand',''),coalesce(p_draft->>'model',''),v_title,
      p_draft->>'category',p_draft->>'condition',p_draft->>'test_status',p_draft->>'location',
      p_ask_cents,v_msrp,v_cost,v_floor,p_draft->>'condition_notes',p_draft->>'upc',p_draft->>'lot',p_draft->>'mfr_serial');
  end if;
  update public.units set ai_description=p_draft->>'description',
    ebay_title=left(coalesce(p_draft->>'ebay_title',''),80), ebay_category=p_draft->>'ebay_category',
    ebay_item_specifics=case when jsonb_typeof(p_draft->'ebay_item_specifics')='object' then p_draft->'ebay_item_specifics' else '{}'::jsonb end,
    retail_price_sources=case when jsonb_typeof(p_draft->'retail_prices')='array' then p_draft->'retail_prices' else '[]'::jsonb end,
    retail_source_name=p_draft->>'retail_source_name',retail_source_url=p_draft->>'retail_source_url'
    where store_id=v_store and sku=v_sku;
  update public.video_scan_jobs set status='saved',sku=v_sku,updated_at=now() where id=p_id;
  return jsonb_build_object('sku',v_sku);
end $$;

select to_regprocedure('public.video_scan_receive(uuid,jsonb,integer)') is not null receive_ready;
commit;
