begin;

-- Preserve manually confirmed Depop ownership in both canonical representations.
-- The historical listings_sync_listed_on trigger is not present in every live
-- baseline; these trusted RPCs therefore maintain units.listed_on themselves.
create or replace function public.floor_depop_record_listing(
 p_store uuid,p_sku text,p_url text default null,p_price_cents integer default null,
 p_listed_at timestamptz default now(),p_actor text default 'listing agent'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.units; v_sku text:=btrim(p_sku); v_url text:=nullif(btrim(p_url),'');
 v_prior text:=current_setting('floor.depop_tracker_record',true); v_old text;
begin
 if p_store is null or nullif(v_sku,'') is null then raise exception 'store_and_sku_required' using errcode='22023'; end if;
 if v_url is not null and v_url !~* '^https://(www\.)?depop\.com/products/[^/?#]+' then raise exception 'invalid_depop_url' using errcode='22023'; end if;
 if p_price_cents is not null and p_price_cents<0 then raise exception 'invalid_depop_price' using errcode='22023'; end if;
 if p_listed_at is not null and (p_listed_at at time zone 'America/Los_Angeles')::date>(now() at time zone 'America/Los_Angeles')::date then raise exception 'listed_date_in_future' using errcode='22023'; end if;
 select * into u from public.units where store_id=p_store and sku=v_sku for update;
 if not found then raise exception 'unit_not_found' using errcode='P0002'; end if;
 if u.state not in ('available','reserved','repair') then raise exception 'depop_unit_not_available: %',u.state using errcode='22023'; end if;
 if exists(select 1 from public.sales s where s.store_id=p_store and s.sku=v_sku and lower(s.channel)='depop' and s.voided_at is null) then raise exception 'depop_unit_already_sold' using errcode='22023'; end if;
 perform public.floor_dns_push_gate(p_store,v_sku,'depop'::text);
 select status into v_old from public.listings where store_id=p_store and sku=v_sku and channel='depop';
 perform set_config('floor.depop_tracker_record','on',true);
 insert into public.listings(store_id,sku,channel,status,listing_id,listed_at,delisted_at,depop_price_cents,depop_added_by)
 values(p_store,v_sku,'depop','listed',v_url,p_listed_at,null,p_price_cents,left(coalesce(nullif(btrim(p_actor),''),'listing agent'),160))
 on conflict(store_id,sku,channel) do update set status='listed',delisted_at=null,
  listing_id=coalesce(excluded.listing_id,listings.listing_id),
  listed_at=coalesce(case when listings.status='listed' then listings.listed_at end,excluded.listed_at),
  depop_price_cents=coalesce(excluded.depop_price_cents,listings.depop_price_cents),
  depop_added_by=coalesce(listings.depop_added_by,excluded.depop_added_by);
 update public.units set listed_on=case when 'depop'=any(coalesce(listed_on,'{}'::text[])) then listed_on else array_append(coalesce(listed_on,'{}'::text[]),'depop') end,updated_at=now()
 where store_id=p_store and sku=v_sku;
 perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);
 if v_old is distinct from 'listed' then
  insert into public.events(store_id,sku,kind,field,old_value,new_value,actor,actor_id,note)
  values(p_store,v_sku,'edit','depop_listing',v_old,'listed',left(coalesce(nullif(btrim(p_actor),''),'listing agent'),160),auth.uid(),'Confirmed live on Depop; tracker only, no inventory or sale change.');
 end if;
 return jsonb_build_object('sku',v_sku,'channel','depop','status','listed');
exception when others then perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);raise;
end $$;

create or replace function public.floor_depop_remove_listing(p_store uuid,p_sku text,p_actor text default 'listing agent')
returns void language plpgsql security definer set search_path=public as $$
declare v_prior text:=current_setting('floor.depop_tracker_record',true);
begin
 if p_store is null or nullif(btrim(p_sku),'') is null then raise exception 'store_and_sku_required' using errcode='22023';end if;
 perform set_config('floor.depop_tracker_record','on',true);
 update public.listings set status='delisted',delisted_at=coalesce(delisted_at,now()),depop_confirmed_at=now()
 where store_id=p_store and sku=btrim(p_sku) and channel='depop';
 update public.units set listed_on=array_remove(coalesce(listed_on,'{}'::text[]),'depop'),updated_at=now()
 where store_id=p_store and sku=btrim(p_sku);
 perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);
exception when others then perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);raise;
end $$;

-- A completed fulfillment step can be undone without touching sales, payments,
-- labels, tracking, or money. Every undo records the signed-in admin and event.
create or replace function public.portal_order_step_back(p_order uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_assert_admin_store(); v_order public.web_orders; v_from text; v_to text; v_name text;
begin
 if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 select * into v_order from public.web_orders where id=p_order and store_id=v_store for update;
 if not found then raise exception 'order_not_found' using errcode='P0002'; end if;
 if v_order.status<>'paid' then raise exception 'order_not_paid' using errcode='22023'; end if;
 if v_order.delivered_at is not null then
  v_from:='delivered';v_to:='shipped';update public.web_orders set delivered_at=null,updated_at=now() where id=p_order;
 elsif v_order.fulfillment='ship' and v_order.shipped_at is not null then
  v_from:='shipped';v_to:='to_ship';update public.web_orders set shipped_at=null,updated_at=now() where id=p_order;
 elsif v_order.fulfillment='pickup' and v_order.picked_up_at is not null then
  v_from:='picked_up';v_to:='awaiting_pickup';update public.web_orders set picked_up_at=null,picked_up_by=null,updated_at=now() where id=p_order;
 else raise exception 'no_completed_step_to_undo' using errcode='22023'; end if;
 v_name:=public.disposition_actor_name(auth.uid());
 insert into public.events(store_id,sku,kind,field,old_value,new_value,actor,actor_id,note)
 values(v_store,v_order.sku,'edit','order_fulfillment_step',v_from,v_to,v_name,auth.uid(),format('Order %s moved back one fulfillment step; sale and money unchanged.',coalesce(v_order.order_no,p_order::text)));
 return jsonb_build_object('order_id',p_order,'from',v_from,'to',v_to,'actor',v_name);
end $$;
revoke all on function public.portal_order_step_back(uuid) from public,anon;
grant execute on function public.portal_order_step_back(uuid) to authenticated;

-- Actual balance reconciliations are appended as dated records. They explain a
-- difference and never rewrite the expected-sales/fees/withdrawal calculation.
create table if not exists public.withdrawal_balance_adjustments(
 id uuid primary key default gen_random_uuid(),store_id uuid not null references public.stores(id) on delete cascade,
 source text not null check(source in ('safe','square','ebay','amazon','tiktok','depop')),
 actual_cents integer not null check(actual_cents>=0),adjusted_on date not null,note text not null,
 created_by uuid,created_at timestamptz not null default now()
);
create index if not exists withdrawal_balance_adjustments_latest on public.withdrawal_balance_adjustments(store_id,source,adjusted_on desc,created_at desc);
alter table public.withdrawal_balance_adjustments enable row level security;
revoke all on public.withdrawal_balance_adjustments from public,anon,authenticated;
grant all on public.withdrawal_balance_adjustments to service_role;
create or replace function public.portal_withdrawal_balance_adjustments()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();
begin
 if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(a) order by a.adjusted_on desc,a.created_at desc) from public.withdrawal_balance_adjustments a where a.store_id=v_store),'[]'::jsonb);
end $$;
create or replace function public.portal_save_withdrawal_balance_adjustment(p_source text,p_actual_cents integer,p_on date,p_note text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_assert_admin_store();v_id uuid;
begin
 if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 if lower(btrim(coalesce(p_source,''))) not in ('safe','square','ebay','amazon','tiktok','depop') then raise exception 'source_invalid' using errcode='22023';end if;
 if p_actual_cents is null or p_actual_cents<0 or p_on is null or nullif(btrim(coalesce(p_note,'')),'') is null then raise exception 'actual_date_note_required' using errcode='22023';end if;
 insert into public.withdrawal_balance_adjustments(store_id,source,actual_cents,adjusted_on,note,created_by)
 values(v_store,lower(btrim(p_source)),p_actual_cents,p_on,btrim(p_note),auth.uid()) returning id into v_id;
 return v_id;
end $$;
revoke all on function public.portal_withdrawal_balance_adjustments() from public,anon;
revoke all on function public.portal_save_withdrawal_balance_adjustment(text,integer,date,text) from public,anon;
grant execute on function public.portal_withdrawal_balance_adjustments() to authenticated;
grant execute on function public.portal_save_withdrawal_balance_adjustment(text,integer,date,text) to authenticated;

-- Sale-specific cost edits preserve the unit's received cost and keep replacement
-- costs additive. Receipt edits write the existing ledger source fields and an
-- immutable before/after audit row; any commission increase for an already-paid
-- ticket becomes a payout adjustment, never a rewritten payment.
create table if not exists public.sale_cost_overrides(
 store_id uuid not null references public.stores(id) on delete cascade,sale_id bigint not null references public.sales(id) on delete cascade,
 cost_cents integer check(cost_cents is null or cost_cents>=0),created_by uuid,updated_by uuid,updated_at timestamptz not null default now(),
 primary key(store_id,sale_id)
);
create table if not exists public.sale_edit_history(
 id bigint generated always as identity primary key,store_id uuid not null references public.stores(id) on delete cascade,
 sale_id bigint not null references public.sales(id) on delete cascade,old_values jsonb not null,new_values jsonb not null,
 actor_id uuid,created_at timestamptz not null default now(),commission_delta jsonb not null default '{}'::jsonb
);
create index if not exists sale_edit_history_sale on public.sale_edit_history(store_id,sale_id,created_at desc);
alter table public.sale_cost_overrides enable row level security;
alter table public.sale_edit_history enable row level security;
revoke all on public.sale_cost_overrides,public.sale_edit_history from public,anon,authenticated;
grant all on public.sale_cost_overrides,public.sale_edit_history to service_role;

create or replace function public.sale_cost_with_replacements(p_sale bigint,p_cost int)
returns int language plpgsql stable security definer set search_path=public as $$
declare v_override int;v_has_override boolean;v_repl int;
begin
 select true,cost_cents into v_has_override,v_override from public.sale_cost_overrides where sale_id=p_sale;
 if v_has_override then
  if v_override is null then return null;end if;
  if not exists(select 1 from public.unit_dispositions d where d.original_sale_id=p_sale and d.kind='replacement' and d.undone_at is null) then return v_override;end if;
  v_repl:=public.sale_replacement_cost(p_sale);if v_repl is null then return null;end if;return v_override+v_repl;
 end if;
 if p_cost is null then return null;end if;
 if not exists(select 1 from public.unit_dispositions d where d.original_sale_id=p_sale and d.kind='replacement' and d.undone_at is null) then return p_cost;end if;
 v_repl:=public.sale_replacement_cost(p_sale);if v_repl is null then return null;end if;return p_cost+v_repl;
end $$;
revoke all on function public.sale_cost_with_replacements(bigint,int) from public,anon;
grant execute on function public.sale_cost_with_replacements(bigint,int) to authenticated,service_role;

create or replace function public.portal_edit_sale_financials(
 p_sale_id bigint,p_price_cents integer,p_shipping_cents integer,p_tax_cents integer,
 p_fee_cents integer,p_label_cents integer,p_other_charge_cents integer,p_cost_cents integer
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_assert_admin_store();v_sale public.sales;v_order public.web_orders;v_provider text;v_order_id text;v_key text;
 v_old jsonb;v_new jsonb;v_before jsonb;v_after jsonb;v_adj jsonb:='{}'::jsonb;v_emp record;v_old_comm integer;v_new_comm integer;v_delta integer;v_hist bigint;
 v_was_paid boolean:=false;v_ticket_snapshot jsonb;v_line_snapshots jsonb;v_commission_snapshots jsonb;
begin
 if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 if p_price_cents is null or p_price_cents<0 or p_shipping_cents is null or p_shipping_cents<0 or p_tax_cents is null or p_tax_cents<0
  or p_fee_cents is null or p_fee_cents<0 or p_label_cents is null or p_label_cents<0 or p_other_charge_cents is null or p_other_charge_cents<0
  or p_cost_cents is not null and p_cost_cents<0 then raise exception 'invalid_sale_amount' using errcode='22023';end if;
 select * into v_sale from public.sales where id=p_sale_id and store_id=v_store and voided_at is null for update;
 if not found then raise exception 'sale_not_found' using errcode='P0002';end if;
 v_key:=coalesce(v_sale.ticket_id::text,'sale:'||v_sale.id::text);
 v_old:=jsonb_build_object('price_cents',v_sale.price_cents,'shipping_cents',coalesce(v_sale.shipping_cents,0),'tax_cents',v_sale.tax_cents,
  'fee_cents',(select coalesce(fee_cents,0) from public.channel_orders where store_id=v_store and sale_id=p_sale_id order by created_at desc limit 1),
  'label_cents',(select coalesce(ship_label_cents,0) from public.channel_orders where store_id=v_store and sale_id=p_sale_id order by created_at desc limit 1),
  'other_charge_cents',0,'cost_cents',case when exists(select 1 from public.sale_cost_overrides where store_id=v_store and sale_id=p_sale_id) then (select cost_cents from public.sale_cost_overrides where store_id=v_store and sale_id=p_sale_id) else (select acquisition_cost_cents from public.units where store_id=v_store and sku=v_sale.sku) end);
 v_before:=coalesce((select jsonb_object_agg(employee_id,amount_cents) from public.sale_commissions where store_id=v_store and ticket_key=v_key),'{}'::jsonb);
 v_was_paid:=exists(select 1 from public.portal_payout_payments p where p.store_id=v_store and p.voided_at is null and p.legacy_ticket_key=v_key)
  and exists(select 1 from public.sale_payout_tickets t where t.store_id=v_store and t.ticket_key=v_key);
 if v_was_paid then
  select to_jsonb(t) into v_ticket_snapshot from public.sale_payout_tickets t where t.store_id=v_store and t.ticket_key=v_key;
  select coalesce(jsonb_agg(to_jsonb(l)),'[]'::jsonb) into v_line_snapshots from public.sale_payout_lines l where l.store_id=v_store and l.ticket_key=v_key;
  select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into v_commission_snapshots from public.sale_commissions c where c.store_id=v_store and c.ticket_key=v_key;
 end if;
 update public.sales set price_cents=p_price_cents,shipping_cents=p_shipping_cents,tax_cents=p_tax_cents where id=p_sale_id and store_id=v_store;
 if v_sale.payment_id like '%:%' then v_provider:=lower(split_part(v_sale.payment_id,':',1));v_order_id:=split_part(v_sale.payment_id,':',2);
 else v_provider:=case when lower(v_sale.channel) in ('floor','website','') then 'manual' else lower(v_sale.channel) end;v_order_id:=coalesce(nullif(v_sale.payment_id,''),'sale:'||p_sale_id::text);end if;
 insert into public.channel_orders(store_id,provider,order_id,sku,sale_id,item_cents,fee_cents,fee_source,ship_label_cents,ship_label_source,tax_cents)
 values(v_store,v_provider,v_order_id,v_sale.sku,p_sale_id,p_price_cents,p_fee_cents+p_other_charge_cents,'manual',p_label_cents,'manual',null)
 on conflict(store_id,provider,order_id) do update set sale_id=coalesce(channel_orders.sale_id,excluded.sale_id),sku=coalesce(channel_orders.sku,excluded.sku),
  item_cents=excluded.item_cents,fee_cents=excluded.fee_cents,fee_source='manual',ship_label_cents=excluded.ship_label_cents,ship_label_source='manual',tax_cents=null;
 update public.channel_orders set item_cents=p_price_cents,fee_cents=p_fee_cents+p_other_charge_cents,fee_source='manual',ship_label_cents=p_label_cents,ship_label_source='manual',tax_cents=null
 where store_id=v_store and sale_id=p_sale_id;
 select * into v_order from public.web_orders where store_id=v_store and sale_id=p_sale_id order by created_at limit 1;
 if found then update public.web_orders set item_cents=p_price_cents,shipping_cents=p_shipping_cents,tax_cents=p_tax_cents,
   total_cents=p_price_cents+p_shipping_cents+p_tax_cents,marketplace_fee_cents=p_fee_cents+p_other_charge_cents,
   label_cost_cents=p_label_cents,updated_at=now() where id=v_order.id and store_id=v_store;end if;
 insert into public.sale_cost_overrides(store_id,sale_id,cost_cents,created_by,updated_by)
 values(v_store,p_sale_id,p_cost_cents,auth.uid(),auth.uid()) on conflict(store_id,sale_id) do update set cost_cents=excluded.cost_cents,updated_by=excluded.updated_by,updated_at=now();
 perform public.portal_payout_refreeze(v_key);
 v_after:=coalesce((select jsonb_object_agg(employee_id,amount_cents) from public.sale_commissions where store_id=v_store and ticket_key=v_key),'{}'::jsonb);
 for v_emp in select coalesce(k1,k2)::uuid employee_id from jsonb_each_text(v_before) a(k1,v1) full join jsonb_each_text(v_after) b(k2,v2) on k1=k2 loop
  v_old_comm:=coalesce((v_before->>v_emp.employee_id::text)::int,0);v_new_comm:=coalesce((v_after->>v_emp.employee_id::text)::int,0);v_delta:=v_new_comm-v_old_comm;
  if v_delta>0 and v_was_paid and exists(select 1 from public.portal_payout_payments p where p.store_id=v_store and p.employee_id=v_emp.employee_id and p.voided_at is null and p.legacy_ticket_key=v_key) then
   insert into public.portal_payout_adjustments(store_id,employee_id,amount_cents,reason,sale_id,ticket_key,sale_commission_cents,created_by)
   values(v_store,v_emp.employee_id,v_delta,'Receipt edit · additional commission',p_sale_id,v_key,v_new_comm,auth.uid());
  end if;
  if v_delta<>0 then v_adj:=v_adj||jsonb_build_object(v_emp.employee_id::text,jsonb_build_object('before_cents',v_old_comm,'after_cents',v_new_comm,'adjustment_cents',case when v_delta>0 and v_was_paid and exists(select 1 from public.portal_payout_payments p where p.store_id=v_store and p.employee_id=v_emp.employee_id and p.voided_at is null and p.legacy_ticket_key=v_key) then v_delta else 0 end,'paid_reduction_not_clawed_back',v_delta<0 and v_was_paid));end if;
 end loop;
 -- If money has already gone out, restore the exact frozen snapshot. The new
 -- amount is recorded above as an adjustment only when it increases what is owed.
 if v_was_paid and v_ticket_snapshot is not null then
  delete from public.sale_payout_tickets where store_id=v_store and ticket_key=v_key;
  insert into public.sale_payout_tickets select (jsonb_populate_record(null::public.sale_payout_tickets,v_ticket_snapshot)).*;
  insert into public.sale_payout_lines select (jsonb_populate_record(null::public.sale_payout_lines,x)).* from jsonb_array_elements(coalesce(v_line_snapshots,'[]'::jsonb)) x;
  insert into public.sale_commissions select (jsonb_populate_record(null::public.sale_commissions,x)).* from jsonb_array_elements(coalesce(v_commission_snapshots,'[]'::jsonb)) x;
 end if;
 v_new:=jsonb_build_object('price_cents',p_price_cents,'shipping_cents',p_shipping_cents,'tax_cents',p_tax_cents,'fee_cents',p_fee_cents,'label_cents',p_label_cents,'other_charge_cents',p_other_charge_cents,'cost_cents',p_cost_cents);
 insert into public.sale_edit_history(store_id,sale_id,old_values,new_values,actor_id,commission_delta) values(v_store,p_sale_id,v_old,v_new,auth.uid(),v_adj) returning id into v_hist;
 return jsonb_build_object('sale_id',p_sale_id,'history_id',v_hist,'commission_delta',v_adj,'ledger',(select to_jsonb(l) from public.sale_ledger l where l.store_id=v_store and l.id=p_sale_id));
end $$;

create or replace function public.portal_sale_edit_history(p_sale_id bigint)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();
begin
 if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 if not exists(select 1 from public.sales where id=p_sale_id and store_id=v_store) then raise exception 'sale_not_found' using errcode='P0002';end if;
 return coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc) from public.sale_edit_history h where h.store_id=v_store and h.sale_id=p_sale_id),'[]'::jsonb);
end $$;
create or replace function public.portal_sale_financial_details(p_sale_id bigint)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();v jsonb;
begin
 if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 select jsonb_build_object(
   'sale_id',s.id,'price_cents',s.price_cents,'shipping_cents',coalesce(s.shipping_cents,0),'tax_cents',coalesce(s.tax_cents,0),
   'fee_cents',coalesce(c.fee_cents,l.channel_fee_cents,0),'label_cents',coalesce(c.ship_label_cents,l.ship_cost_cents,0),
   'other_charge_cents',0,'cost_cents',case when o.sale_id is not null then o.cost_cents else u.acquisition_cost_cents end,
   'ledger',to_jsonb(l),'channel_order',to_jsonb(c),'web_order',to_jsonb(w)) into v
 from public.sales s left join public.sale_ledger l on l.id=s.id
 left join lateral (select * from public.channel_orders x where x.store_id=s.store_id and x.sale_id=s.id order by x.created_at desc limit 1)c on true
 left join lateral (select * from public.web_orders x where x.store_id=s.store_id and x.sale_id=s.id order by x.created_at limit 1)w on true
 left join public.sale_cost_overrides o on o.store_id=s.store_id and o.sale_id=s.id
 left join public.units u on u.store_id=s.store_id and u.sku=s.sku
 where s.store_id=v_store and s.id=p_sale_id and s.voided_at is null;
 if v is null then raise exception 'sale_not_found' using errcode='P0002';end if;
 return v;
end $$;
revoke all on function public.portal_edit_sale_financials(bigint,integer,integer,integer,integer,integer,integer,integer) from public,anon;
revoke all on function public.portal_sale_edit_history(bigint) from public,anon;
revoke all on function public.portal_sale_financial_details(bigint) from public,anon;
grant execute on function public.portal_edit_sale_financials(bigint,integer,integer,integer,integer,integer,integer,integer) to authenticated;
grant execute on function public.portal_sale_edit_history(bigint) to authenticated;
grant execute on function public.portal_sale_financial_details(bigint) to authenticated;

-- Back up and seed the owner's complete, manually verified Depop shop roster.
-- This is tracker data only: it does not create sales or change item states.
create table if not exists public.depop_roster_seed_backup(
 store_id uuid not null,sku text not null,captured_at timestamptz not null default now(),
 prior_listing jsonb,prior_unit_listed_on text[],primary key(store_id,sku)
);
alter table public.depop_roster_seed_backup enable row level security;
revoke all on public.depop_roster_seed_backup from public,anon,authenticated;
grant all on public.depop_roster_seed_backup to service_role;
insert into public.depop_roster_seed_backup(store_id,sku,prior_listing,prior_unit_listed_on)
select u.store_id,u.sku,to_jsonb(l),u.listed_on from public.units u
left join public.listings l on l.store_id=u.store_id and l.sku=u.sku and l.channel='depop'
where u.store_id='5487ca47-6147-4fe8-bc6d-46b6472726ba' and u.sku in (
    ('11200'),
    ('11201'),
    ('11202'),
    ('11203'),
    ('11204'),
    ('11205'),
    ('11206'),
    ('11207'),
    ('11208'),
    ('11209'),
    ('11210'),
    ('11211'),
    ('11212'),
    ('11213'),
    ('11214'),
    ('11216'),
    ('11218'),
    ('11219'),
    ('11220'),
    ('11222'),
    ('11223'),
    ('11224'),
    ('11225'),
    ('11226'),
    ('11227'),
    ('11228'),
    ('11229'),
    ('11230'),
    ('11231'),
    ('11232'),
    ('11233'),
    ('11234'),
    ('11235'),
    ('11237'),
    ('11238'),
    ('11240'),
    ('11243'),
    ('11251'),
    ('11252'),
    ('11253'),
    ('11254'),
    ('11256'),
    ('11258'),
    ('11259'),
    ('11268'),
    ('11270'),
    ('11271'),
    ('11272'),
    ('11273'),
    ('11274'),
    ('11275'),
    ('11276'),
    ('11277'),
    ('11278'),
    ('11279'),
    ('11281'),
    ('11283'),
    ('11285'),
    ('11286'),
    ('11287'),
    ('11288'),
    ('11289'),
    ('11290'),
    ('11291'),
    ('11292'),
    ('11293'),
    ('11295'),
    ('11296'),
    ('11297'),
    ('11298'),
    ('11300'),
    ('11301'),
    ('11308'),
    ('11318'),
    ('11328'),
    ('11329'),
    ('11333'),
    ('11335'),
    ('11339'),
    ('11343'),
    ('11349'),
    ('11354'),
    ('11357'),
    ('11359'),
    ('11362'),
    ('11364'),
    ('11372'),
    ('11376'),
    ('11380'),
    ('11382'),
    ('11413'),
    ('11416'),
    ('11424'),
    ('11428'),
    ('11432'),
    ('11433'),
    ('11435'),
    ('11439'),
    ('11442'),
    ('11452'),
    ('11467'),
    ('11482'),
    ('11486'),
    ('11487'),
    ('11488'),
    ('11496'),
    ('11497'),
    ('11502'),
    ('11511'),
    ('11514'),
    ('11525'),
    ('11526'),
    ('11528'),
    ('11532'),
    ('11533'),
    ('11534'),
    ('11535'),
    ('11536'),
    ('11537'),
    ('11538'),
    ('11541'),
    ('11542'),
    ('11543'),
    ('11544'),
    ('11545'),
    ('11546'),
    ('11614'),
    ('11617'),
    ('11618'),
    ('11619'),
    ('11620'),
    ('11621'),
    ('11622'),
    ('11623'),
    ('11624'),
    ('11625'),
    ('11626'),
    ('11627'),
    ('11628'),
    ('11630'),
    ('11631'),
    ('11634'),
    ('11635'),
    ('11636'),
    ('11637'),
    ('11638'),
    ('11639'),
    ('11640'),
    ('11641'),
    ('11642'),
    ('11643'),
    ('11644'),
    ('11645'),
    ('11646'),
    ('11647'),
    ('11648'),
    ('11649'),
    ('11650'),
    ('11651'),
    ('11652'),
    ('11653'),
    ('11654'),
    ('11655'),
    ('11656'),
    ('11657'),
    ('11658'),
    ('11659'),
    ('11660'),
    ('11661'),
    ('11662'),
    ('11663'),
    ('11664'),
    ('11666'),
    ('11671'),
    ('11672'),
    ('11673'),
    ('11674'),
    ('11675'),
    ('11676'),
    ('11677'),
    ('11678'),
    ('11679'),
    ('11680'),
    ('11681'),
    ('11682'),
    ('11683'),
    ('11684'),
    ('11685'),
    ('11686'),
    ('11687'),
    ('11688'),
    ('11690'),
    ('11720'),
    ('11721'),
    ('11724'),
    ('11751'),
    ('11754'),
    ('11755'),
    ('11757'),
    ('11758'),
    ('11763'),
    ('11798'),
    ('11826'),
    ('99086'),
    ('99087'),
    ('99091'),
    ('99092'),
    ('99093'),
    ('99095'),
    ('99096'),
    ('99100'),
    ('99103'),
    ('99105'),
    ('99107'),
    ('99109'),
    ('99113'),
    ('99114'),
    ('99116'),
    ('99119'),
    ('99700'),
    ('99703'),
    ('99704'),
    ('99708'),
    ('99709'),
    ('99710'),
    ('99711'),
    ('99713'),
    ('99714'),
    ('99715'),
    ('99789'),
    ('99790'),
    ('99791'),
    ('99792')
) on conflict(store_id,sku) do nothing;
-- The source list records active shop ownership, including sold-elsewhere rows
-- that must remain visible until physically removed from Depop. Bypass the two
-- status guards only during this single, explicitly enumerated historical seed.
alter table public.listings disable trigger aaa_depop_tracker_ownership;
alter table public.listings disable trigger floor_bundle_listing_guard;
insert into public.listings(store_id,sku,channel,status,listed_at,depop_confirmed_at,depop_added_by)
select u.store_id,u.sku,'depop','listed',now(),now(),'Owner-confirmed live Depop roster'
from public.units u where u.store_id='5487ca47-6147-4fe8-bc6d-46b6472726ba' and u.sku in (
    ('11200'),
    ('11201'),
    ('11202'),
    ('11203'),
    ('11204'),
    ('11205'),
    ('11206'),
    ('11207'),
    ('11208'),
    ('11209'),
    ('11210'),
    ('11211'),
    ('11212'),
    ('11213'),
    ('11214'),
    ('11216'),
    ('11218'),
    ('11219'),
    ('11220'),
    ('11222'),
    ('11223'),
    ('11224'),
    ('11225'),
    ('11226'),
    ('11227'),
    ('11228'),
    ('11229'),
    ('11230'),
    ('11231'),
    ('11232'),
    ('11233'),
    ('11234'),
    ('11235'),
    ('11237'),
    ('11238'),
    ('11240'),
    ('11243'),
    ('11251'),
    ('11252'),
    ('11253'),
    ('11254'),
    ('11256'),
    ('11258'),
    ('11259'),
    ('11268'),
    ('11270'),
    ('11271'),
    ('11272'),
    ('11273'),
    ('11274'),
    ('11275'),
    ('11276'),
    ('11277'),
    ('11278'),
    ('11279'),
    ('11281'),
    ('11283'),
    ('11285'),
    ('11286'),
    ('11287'),
    ('11288'),
    ('11289'),
    ('11290'),
    ('11291'),
    ('11292'),
    ('11293'),
    ('11295'),
    ('11296'),
    ('11297'),
    ('11298'),
    ('11300'),
    ('11301'),
    ('11308'),
    ('11318'),
    ('11328'),
    ('11329'),
    ('11333'),
    ('11335'),
    ('11339'),
    ('11343'),
    ('11349'),
    ('11354'),
    ('11357'),
    ('11359'),
    ('11362'),
    ('11364'),
    ('11372'),
    ('11376'),
    ('11380'),
    ('11382'),
    ('11413'),
    ('11416'),
    ('11424'),
    ('11428'),
    ('11432'),
    ('11433'),
    ('11435'),
    ('11439'),
    ('11442'),
    ('11452'),
    ('11467'),
    ('11482'),
    ('11486'),
    ('11487'),
    ('11488'),
    ('11496'),
    ('11497'),
    ('11502'),
    ('11511'),
    ('11514'),
    ('11525'),
    ('11526'),
    ('11528'),
    ('11532'),
    ('11533'),
    ('11534'),
    ('11535'),
    ('11536'),
    ('11537'),
    ('11538'),
    ('11541'),
    ('11542'),
    ('11543'),
    ('11544'),
    ('11545'),
    ('11546'),
    ('11614'),
    ('11617'),
    ('11618'),
    ('11619'),
    ('11620'),
    ('11621'),
    ('11622'),
    ('11623'),
    ('11624'),
    ('11625'),
    ('11626'),
    ('11627'),
    ('11628'),
    ('11630'),
    ('11631'),
    ('11634'),
    ('11635'),
    ('11636'),
    ('11637'),
    ('11638'),
    ('11639'),
    ('11640'),
    ('11641'),
    ('11642'),
    ('11643'),
    ('11644'),
    ('11645'),
    ('11646'),
    ('11647'),
    ('11648'),
    ('11649'),
    ('11650'),
    ('11651'),
    ('11652'),
    ('11653'),
    ('11654'),
    ('11655'),
    ('11656'),
    ('11657'),
    ('11658'),
    ('11659'),
    ('11660'),
    ('11661'),
    ('11662'),
    ('11663'),
    ('11664'),
    ('11666'),
    ('11671'),
    ('11672'),
    ('11673'),
    ('11674'),
    ('11675'),
    ('11676'),
    ('11677'),
    ('11678'),
    ('11679'),
    ('11680'),
    ('11681'),
    ('11682'),
    ('11683'),
    ('11684'),
    ('11685'),
    ('11686'),
    ('11687'),
    ('11688'),
    ('11690'),
    ('11720'),
    ('11721'),
    ('11724'),
    ('11751'),
    ('11754'),
    ('11755'),
    ('11757'),
    ('11758'),
    ('11763'),
    ('11798'),
    ('11826'),
    ('99086'),
    ('99087'),
    ('99091'),
    ('99092'),
    ('99093'),
    ('99095'),
    ('99096'),
    ('99100'),
    ('99103'),
    ('99105'),
    ('99107'),
    ('99109'),
    ('99113'),
    ('99114'),
    ('99116'),
    ('99119'),
    ('99700'),
    ('99703'),
    ('99704'),
    ('99708'),
    ('99709'),
    ('99710'),
    ('99711'),
    ('99713'),
    ('99714'),
    ('99715'),
    ('99789'),
    ('99790'),
    ('99791'),
    ('99792')
)
on conflict(store_id,sku,channel) do update set status='listed',delisted_at=null,
 depop_confirmed_at=coalesce(listings.depop_confirmed_at,excluded.depop_confirmed_at),
 depop_added_by=coalesce(listings.depop_added_by,excluded.depop_added_by);
alter table public.listings enable trigger aaa_depop_tracker_ownership;
alter table public.listings enable trigger floor_bundle_listing_guard;
update public.units set listed_on=case when 'depop'=any(coalesce(listed_on,'{}'::text[])) then listed_on else array_append(coalesce(listed_on,'{}'::text[]),'depop') end,updated_at=now()
where store_id='5487ca47-6147-4fe8-bc6d-46b6472726ba' and sku in (
    ('11200'),
    ('11201'),
    ('11202'),
    ('11203'),
    ('11204'),
    ('11205'),
    ('11206'),
    ('11207'),
    ('11208'),
    ('11209'),
    ('11210'),
    ('11211'),
    ('11212'),
    ('11213'),
    ('11214'),
    ('11216'),
    ('11218'),
    ('11219'),
    ('11220'),
    ('11222'),
    ('11223'),
    ('11224'),
    ('11225'),
    ('11226'),
    ('11227'),
    ('11228'),
    ('11229'),
    ('11230'),
    ('11231'),
    ('11232'),
    ('11233'),
    ('11234'),
    ('11235'),
    ('11237'),
    ('11238'),
    ('11240'),
    ('11243'),
    ('11251'),
    ('11252'),
    ('11253'),
    ('11254'),
    ('11256'),
    ('11258'),
    ('11259'),
    ('11268'),
    ('11270'),
    ('11271'),
    ('11272'),
    ('11273'),
    ('11274'),
    ('11275'),
    ('11276'),
    ('11277'),
    ('11278'),
    ('11279'),
    ('11281'),
    ('11283'),
    ('11285'),
    ('11286'),
    ('11287'),
    ('11288'),
    ('11289'),
    ('11290'),
    ('11291'),
    ('11292'),
    ('11293'),
    ('11295'),
    ('11296'),
    ('11297'),
    ('11298'),
    ('11300'),
    ('11301'),
    ('11308'),
    ('11318'),
    ('11328'),
    ('11329'),
    ('11333'),
    ('11335'),
    ('11339'),
    ('11343'),
    ('11349'),
    ('11354'),
    ('11357'),
    ('11359'),
    ('11362'),
    ('11364'),
    ('11372'),
    ('11376'),
    ('11380'),
    ('11382'),
    ('11413'),
    ('11416'),
    ('11424'),
    ('11428'),
    ('11432'),
    ('11433'),
    ('11435'),
    ('11439'),
    ('11442'),
    ('11452'),
    ('11467'),
    ('11482'),
    ('11486'),
    ('11487'),
    ('11488'),
    ('11496'),
    ('11497'),
    ('11502'),
    ('11511'),
    ('11514'),
    ('11525'),
    ('11526'),
    ('11528'),
    ('11532'),
    ('11533'),
    ('11534'),
    ('11535'),
    ('11536'),
    ('11537'),
    ('11538'),
    ('11541'),
    ('11542'),
    ('11543'),
    ('11544'),
    ('11545'),
    ('11546'),
    ('11614'),
    ('11617'),
    ('11618'),
    ('11619'),
    ('11620'),
    ('11621'),
    ('11622'),
    ('11623'),
    ('11624'),
    ('11625'),
    ('11626'),
    ('11627'),
    ('11628'),
    ('11630'),
    ('11631'),
    ('11634'),
    ('11635'),
    ('11636'),
    ('11637'),
    ('11638'),
    ('11639'),
    ('11640'),
    ('11641'),
    ('11642'),
    ('11643'),
    ('11644'),
    ('11645'),
    ('11646'),
    ('11647'),
    ('11648'),
    ('11649'),
    ('11650'),
    ('11651'),
    ('11652'),
    ('11653'),
    ('11654'),
    ('11655'),
    ('11656'),
    ('11657'),
    ('11658'),
    ('11659'),
    ('11660'),
    ('11661'),
    ('11662'),
    ('11663'),
    ('11664'),
    ('11666'),
    ('11671'),
    ('11672'),
    ('11673'),
    ('11674'),
    ('11675'),
    ('11676'),
    ('11677'),
    ('11678'),
    ('11679'),
    ('11680'),
    ('11681'),
    ('11682'),
    ('11683'),
    ('11684'),
    ('11685'),
    ('11686'),
    ('11687'),
    ('11688'),
    ('11690'),
    ('11720'),
    ('11721'),
    ('11724'),
    ('11751'),
    ('11754'),
    ('11755'),
    ('11757'),
    ('11758'),
    ('11763'),
    ('11798'),
    ('11826'),
    ('99086'),
    ('99087'),
    ('99091'),
    ('99092'),
    ('99093'),
    ('99095'),
    ('99096'),
    ('99100'),
    ('99103'),
    ('99105'),
    ('99107'),
    ('99109'),
    ('99113'),
    ('99114'),
    ('99116'),
    ('99119'),
    ('99700'),
    ('99703'),
    ('99704'),
    ('99708'),
    ('99709'),
    ('99710'),
    ('99711'),
    ('99713'),
    ('99714'),
    ('99715'),
    ('99789'),
    ('99790'),
    ('99791'),
    ('99792')
);
commit;
