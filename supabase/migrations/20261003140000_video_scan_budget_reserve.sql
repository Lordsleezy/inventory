begin;

alter table public.video_scan_jobs alter column reserved_usd set default 1.00;

create or replace function public.video_scan_create(p_id uuid,p_video_path text,p_still_paths text[])
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.video_scan_store_id(); v_cap numeric; v_used numeric;
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
  select coalesce(sum(estimated_cost_usd+reserved_usd),0) into v_used
    from public.video_scan_jobs where store_id=v_store
      and created_at>=date_trunc('month',now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
      and created_at<(date_trunc('month',now() at time zone 'America/Los_Angeles')+interval '1 month') at time zone 'America/Los_Angeles';
  if v_used+1.00>v_cap then raise exception 'monthly_ai_cap_reached' using errcode='P0001'; end if;
  insert into public.video_scan_jobs(id,store_id,created_by,video_path,still_paths,reserved_usd)
    values(p_id,v_store,auth.uid(),p_video_path,coalesce(p_still_paths,'{}'::text[]),1.00);
  return jsonb_build_object('id',p_id,'monthly_cap_usd',v_cap,'month_spend_usd',v_used);
end $$;

select to_regprocedure('public.video_scan_create(uuid,text,text[])') is not null create_ready;
commit;
