begin;

-- Google includes 5,000 Search grounding queries per month across Gemini 3.x.
-- Floor can estimate only queries it logged; other uses of the same Google project
-- may consume the shared allowance.
create or replace function public.video_scan_month_usage(p_store uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  with counts as (
    select coalesce(sum(input_tokens),0)::numeric inputs,
           coalesce(sum(output_tokens),0)::numeric outputs,
           coalesce(sum(search_queries),0)::numeric searches,
           coalesce(sum(reserved_usd),0)::numeric reserved
    from public.video_scan_jobs
    where store_id=p_store
      and created_at>=date_trunc('month',now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
      and created_at<(date_trunc('month',now() at time zone 'America/Los_Angeles')+interval '1 month') at time zone 'America/Los_Angeles'
  )
  select jsonb_build_object(
    'spent_usd',round(inputs*0.75/1000000+outputs*3.75/1000000+greatest(searches-5000,0)*0.014,5),
    'reserved_usd',reserved,'search_queries',searches,
    'free_search_queries_remaining',greatest(5000-searches,0))
  from counts;
$$;
revoke all on function public.video_scan_month_usage(uuid) from public,anon,authenticated;

create or replace function public.video_scan_budget()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.video_scan_store_id(); v_cap numeric; v_usage jsonb;
begin
  if v_store is null then raise exception 'scan_access_denied' using errcode='42501'; end if;
  select monthly_cap_usd into v_cap from public.video_scan_settings where store_id=v_store;
  v_usage:=public.video_scan_month_usage(v_store);
  return v_usage||jsonb_build_object('monthly_cap_usd',coalesce(v_cap,30));
end $$;

create or replace function public.video_scan_create(p_id uuid,p_video_path text,p_still_paths text[])
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.video_scan_store_id(); v_cap numeric; v_used numeric; v_usage jsonb;
begin
  if v_store is null then raise exception 'scan_access_denied' using errcode='42501'; end if;
  if p_id is null or p_video_path not in (v_store::text||'/'||auth.uid()::text||'/'||p_id::text||'/video.mp4',
       v_store::text||'/'||auth.uid()::text||'/'||p_id::text||'/video.webm')
     or coalesce(array_length(p_still_paths,1),0)>4
     or exists(select 1 from unnest(coalesce(p_still_paths,'{}'::text[])) p
       where p not like v_store::text||'/'||auth.uid()::text||'/'||p_id::text||'/still-%.jpg') then
    raise exception 'invalid_scan_paths' using errcode='22023';
  end if;
  insert into public.video_scan_settings(store_id) values(v_store) on conflict do nothing;
  select monthly_cap_usd into v_cap from public.video_scan_settings where store_id=v_store for update;
  v_usage:=public.video_scan_month_usage(v_store);
  v_used:=(v_usage->>'spent_usd')::numeric+(v_usage->>'reserved_usd')::numeric;
  if v_used+1.00>v_cap then raise exception 'monthly_ai_cap_reached' using errcode='P0001'; end if;
  insert into public.video_scan_jobs(id,store_id,created_by,video_path,still_paths,reserved_usd)
    values(p_id,v_store,auth.uid(),p_video_path,coalesce(p_still_paths,'{}'::text[]),1.00);
  return jsonb_build_object('id',p_id,'monthly_cap_usd',v_cap,'month_spend_usd',v_used);
end $$;

select to_regprocedure('public.video_scan_month_usage(uuid)') is not null budget_ready,
       to_regprocedure('public.video_scan_create(uuid,text,text[])') is not null create_ready;
commit;
