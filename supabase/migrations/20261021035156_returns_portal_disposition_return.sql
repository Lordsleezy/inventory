create or replace function public.portal_disposition_return(
  p_return uuid,
  p_disposition text,
  p_patch jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_disp text := lower(btrim(coalesce(p_disposition, '')));
  v_settings jsonb;
  v_ch text;
  v_photos int;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_disp not in ('relist', 'downgrade_channel', 'bundle_lot', 'write_off') then
    raise exception 'invalid_disposition' using errcode = '22023';
  end if;

  select * into r from public.returns where id = p_return and store_id = v_store for update;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;
  if r.status not in ('inspected', 'received', 'dispositioned') then
    raise exception 'inspect_before_disposition' using errcode = 'P0001';
  end if;

  select count(*)::int into v_photos from public.return_photos where return_id = r.id;
  if v_photos < 1 then
    raise exception 'inspection_photos_required' using errcode = 'P0001';
  end if;

  v_settings := public.return_settings(v_store);

  update public.returns set
    refund_cents = coalesce((p_patch->>'refund_cents')::int, refund_cents),
    return_label_cents = coalesce((p_patch->>'return_label_cents')::int, return_label_cents),
    unrecovered_fees_cents = coalesce((p_patch->>'unrecovered_fees_cents')::int, unrecovered_fees_cents),
    regrade_loss_cents = coalesce((p_patch->>'regrade_loss_cents')::int, regrade_loss_cents),
    label_paid_by = coalesce(nullif(p_patch->>'label_paid_by',''), label_paid_by),
    updated_at = now()
  where id = r.id
  returning * into r;

  -- Clawbacks while sale is still live, then void.
  perform public.return_apply_commission_clawbacks(r.id);

  if r.sale_id is not null then
    perform public.return_reverse_sale(
      v_store, r.sale_id,
      'Return disposition: ' || v_disp,
      v_disp <> 'write_off' or coalesce((p_patch->>'restock')::boolean, false)
    );
  else
    if v_disp in ('relist', 'downgrade_channel', 'bundle_lot') then
      update public.units set state = 'available', updated_at = now()
       where store_id = v_store and sku = r.sku and state in ('sold', 'reserved');
      update public.sku_ledger set fate = 'issued'
       where store_id = v_store and sku = r.sku;
    elsif v_disp = 'write_off' then
      update public.units set state = 'scrapped', updated_at = now()
       where store_id = v_store and sku = r.sku;
      update public.sku_ledger set fate = 'retired'
       where store_id = v_store and sku = r.sku;
    end if;
  end if;

  if v_disp = 'downgrade_channel' then
    for v_ch in
      select lower(btrim(x)) from jsonb_array_elements_text(
        coalesce(v_settings->'downgrade_block_channels', '["amazon","tiktok"]'::jsonb)
      ) x
    loop
      insert into public.unit_marketplace_overrides(store_id, sku, channel, decision, note, actor_id, actor_name)
      values (
        v_store, r.sku, v_ch, 'block',
        'Return downgrade — pulled from forced-return channels',
        auth.uid(),
        coalesce((select display_name from public.staff where user_id = auth.uid()), 'portal')
      )
      on conflict (store_id, sku, channel) do update set
        decision = 'block', note = excluded.note, updated_at = now(),
        actor_id = excluded.actor_id, actor_name = excluded.actor_name;
    end loop;
  end if;

  if v_disp = 'bundle_lot' then
    update public.units set
      listing_body = trim(both from coalesce(listing_body, '') || E'\n[RETURN → bundle lot]'),
      updated_at = now()
     where store_id = v_store and sku = r.sku;
    insert into public.unit_marketplace_overrides(store_id, sku, channel, decision, note, actor_id, actor_name)
    select v_store, r.sku, c, 'block', 'Return → bundle lot only', auth.uid(), 'portal'
      from unnest(array['amazon','tiktok']) c
    on conflict (store_id, sku, channel) do update set
      decision = 'block', note = excluded.note, updated_at = now();
  end if;

  if v_disp = 'write_off' then
    insert into public.unit_marketplace_overrides(store_id, sku, channel, decision, note, actor_id, actor_name)
    select v_store, r.sku, c, 'block', 'Return write-off', auth.uid(), 'portal'
      from unnest(array['amazon','tiktok','ebay','mercari','website','depop','whatnot','facebook']) c
    on conflict (store_id, sku, channel) do update set
      decision = 'block', note = excluded.note, updated_at = now();
  end if;

  if v_disp = 'relist' and coalesce((p_patch->>'clear_channel_blocks')::boolean, false) then
    delete from public.unit_marketplace_overrides
     where store_id = v_store and sku = r.sku
       and channel in ('amazon', 'tiktok')
       and note like 'Return%';
  end if;

  update public.returns set
    status = 'dispositioned',
    disposition = v_disp,
    dispositioned_at = coalesce(dispositioned_at, now()),
    refunded_at = coalesce(refunded_at, case when coalesce((p_patch->>'mark_refunded')::boolean, true) then now() else null end),
    updated_at = now()
  where id = r.id
  returning * into r;

  perform public.return_post_ledger(r.id);

  if coalesce((p_patch->>'close')::boolean, true) then
    update public.returns set status = 'closed', closed_at = coalesce(closed_at, now()), closed_by = auth.uid(), updated_at = now()
     where id = r.id returning * into r;
  end if;

  if exists (select 1 from public.sku_ledger where store_id = v_store and sku = r.sku) then
    insert into public.events (store_id, sku, kind, actor, note)
    values (v_store, r.sku, 'return_dispositioned',
            coalesce((select display_name from public.staff where user_id = auth.uid()), 'portal'),
            v_disp);
  end if;

  return to_jsonb(r);
end $$;

revoke all on function public.portal_disposition_return(uuid, text, jsonb) from public, anon;

grant execute on function public.portal_disposition_return(uuid, text, jsonb) to authenticated;
