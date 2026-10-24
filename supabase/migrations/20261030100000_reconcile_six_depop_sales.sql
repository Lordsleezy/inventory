-- Reconcile six verified Depop spreadsheet rows against the live floor store.
-- Buyer-paid shipping and marketplace tax are intentionally not added to revenue.
-- Original payment IDs and order numbers remain intact.
begin;

create table if not exists public.marketplace_reconciliation_audit (
  id bigint generated always as identity primary key,
  store_id uuid not null,
  provider text not null,
  external_order_id text not null,
  buyer_handle text not null,
  verified_sku text,
  verified_item_cents integer not null,
  verified_fee_cents integer not null,
  verified_payout_cents integer not null,
  source_note text not null,
  before_rows jsonb not null,
  after_rows jsonb,
  corrected_at timestamptz not null default now(),
  unique (store_id, provider, external_order_id)
);
alter table public.marketplace_reconciliation_audit enable row level security;
revoke all on public.marketplace_reconciliation_audit from public, anon, authenticated;
grant select on public.marketplace_reconciliation_audit to service_role;

create temporary table depop_verified (
  external_order_id text primary key, buyer_handle text not null, verified_sku text,
  item_cents integer not null, fee_cents integer not null, payout_cents integer not null,
  web_order_id uuid not null, expected_sale_id bigint
) on commit drop;
insert into depop_verified
select v.external_order_id,v.buyer_handle,v.verified_sku,v.item_cents,v.fee_cents,
  v.payout_cents,v.web_order_id::uuid,v.expected_sale_id::bigint from (values
 ('478386059381','kay_lucha','11352',1999,136,1863,'fed7b310-ccf5-48b3-bb86-3e9550ed126b',124),
 ('477954162338','kwfastkat1988','11406',1499,94,1405,'5b6e8ff9-0ae2-4004-af70-9baaa4abe258',null),
 ('477909417053','f102z','99102',2800,145,2655,'8e94bb52-317b-49c4-bf13-4e4b05ff2c68',null),
 ('477564801434','slpb5',null,1800,115,1685,'cc2b287d-b5f5-498d-9f66-906943744556',75),
 ('477520571840','melps_ex','99106',3670,197,3473,'dbd598f4-61b8-4268-8cb6-3d00203b5f38',76),
 ('477486291306','len112255',null,2500,144,2356,'5ef40790-4d84-462d-b4da-e1f49f22fe3f',59)
) as v(external_order_id,buyer_handle,verified_sku,item_cents,fee_cents,payout_cents,web_order_id,expected_sale_id)
where exists (select 1 from public.stores where id='5487ca47-6147-4fe8-bc6d-46b6472726ba');

do $$
declare v_store uuid := '5487ca47-6147-4fe8-bc6d-46b6472726ba'; v_bad int;
begin
  if not exists (select 1 from public.stores where id=v_store) then return; end if;
  if (select count(*) from depop_verified)<>6 then raise exception 'Expected six verified Depop rows'; end if;
  select count(*) into v_bad from depop_verified v
  left join public.web_orders o on o.id=v.web_order_id
  where o.id is null or o.store_id<>v_store or o.channel<>'depop' or o.status<>'paid'
    or o.item_cents<>v.item_cents or o.sale_id is distinct from v.expected_sale_id
    or (v.expected_sale_id is null and lower(coalesce(o.buyer_name,'')) <> '@'||v.buyer_handle)
    or (v.expected_sale_id is not null and not exists (
      select 1 from public.sales s where s.id=o.sale_id and s.store_id=v_store
        and s.channel='depop' and s.voided_at is null and s.price_cents=v.item_cents
        and (v.verified_sku is null or s.sku=v.verified_sku)));
  if v_bad<>0 then raise exception 'Depop reconciliation identity check failed for % rows', v_bad; end if;
  if exists (select 1 from public.marketplace_reconciliation_audit where store_id=v_store and provider='depop'
    and external_order_id in (select external_order_id from depop_verified)) then
    raise exception 'Depop reconciliation already recorded';
  end if;
  if (select count(*) from public.units where store_id=v_store and sku in ('11406','99102') and state='available')<>2 then
    raise exception 'Known unmatched Depop SKUs are not both available';
  end if;
end $$;

insert into public.marketplace_reconciliation_audit
 (store_id,provider,external_order_id,buyer_handle,verified_sku,verified_item_cents,
  verified_fee_cents,verified_payout_cents,source_note,before_rows)
select '5487ca47-6147-4fe8-bc6d-46b6472726ba','depop',v.external_order_id,v.buyer_handle,
  v.verified_sku,v.item_cents,v.fee_cents,v.payout_cents,
  'Verified Depop spreadsheet, October 10-20 2026; matched by available buyer handle or existing Vendoo sale title, date, price, and known SKU. Original payment IDs retained.',
  jsonb_build_object(
    'web_orders',(select coalesce(jsonb_agg(to_jsonb(o) order by o.created_at),'[]'::jsonb)
      from public.web_orders o where o.id=v.web_order_id or (v.expected_sale_id is not null and o.sale_id=v.expected_sale_id)),
    'sales',(select to_jsonb(s) from public.sales s where s.id=v.expected_sale_id),
    'channel_orders',(select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb)
      from public.channel_orders c where c.sale_id=v.expected_sale_id
        or (v.expected_sale_id is null and c.store_id='5487ca47-6147-4fe8-bc6d-46b6472726ba'
          and c.provider='depop' and c.order_id=split_part((select payment_id from public.web_orders where id=v.web_order_id), 'depop:', 2))),
    'marketplace_email_sales',(select coalesce(jsonb_agg(to_jsonb(m)),'[]'::jsonb)
      from public.marketplace_email_sales m where m.sale_id=v.expected_sale_id
        or (v.expected_sale_id is null and m.store_id='5487ca47-6147-4fe8-bc6d-46b6472726ba'
          and m.buyer->>'handle'=v.buyer_handle))
  )
from depop_verified v;

-- Use the existing order-linking workflow to sell the two verified available units.
-- The function preserves each web order's payment_id and creates the sale/event/delist records.
do $$ begin
  if exists (select 1 from depop_verified) then
    perform set_config('request.jwt.claim.sub','68b0d022-b9e4-427e-ab25-5399bc4cfd41',true);
    perform set_config('request.jwt.claim.role','service_role',true);
    perform public.portal_match_web_order('5b6e8ff9-0ae2-4004-af70-9baaa4abe258','11406');
    perform public.portal_match_web_order('8e94bb52-317b-49c4-bf13-4e4b05ff2c68','99102');
  end if;
end $$;
update public.sales s set sold_at=o.paid_at
from public.web_orders o
where o.id in ('5b6e8ff9-0ae2-4004-af70-9baaa4abe258','8e94bb52-317b-49c4-bf13-4e4b05ff2c68')
  and s.id=o.sale_id and s.store_id=o.store_id and o.paid_at is not null;
-- The linked kay_lucha sale was entered on October 23, but the verified
-- Depop order date is October 20. The source provides a date, not a time;
-- use local noon and preserve the original timestamp in the audit snapshot.
update public.sales set sold_at='2026-10-20 12:00:00-07'::timestamptz
where id=124 and store_id='5487ca47-6147-4fe8-bc6d-46b6472726ba';

-- Mark verified payment processing fees as actual. Do not count buyer shipping as store proceeds.
update public.web_orders o set marketplace_fee_cents=v.fee_cents, updated_at=now()
from depop_verified v where o.id=v.web_order_id and o.store_id='5487ca47-6147-4fe8-bc6d-46b6472726ba';
update public.channel_orders c set fee_cents=v.fee_cents, fee_source='actual', payout_cents=v.payout_cents,
  sku=coalesce(v.verified_sku,c.sku), sale_id=coalesce(c.sale_id,o.sale_id)
from depop_verified v join public.web_orders o on o.id=v.web_order_id
where c.store_id=o.store_id and c.provider='depop'
  and (c.sale_id=o.sale_id or (o.sale_id is not null and c.order_id=split_part(o.payment_id,'depop:',2)))
  and (v.expected_sale_id is not null or c.order_id=split_part(o.payment_id,'depop:',2));
insert into public.channel_orders
  (store_id,provider,order_id,sku,sale_id,item_cents,fee_cents,fee_source,payout_cents)
select o.store_id,'depop',split_part(o.payment_id,'depop:',2),o.sku,o.sale_id,v.item_cents,v.fee_cents,'actual',v.payout_cents
from depop_verified v join public.web_orders o on o.id=v.web_order_id
where v.external_order_id='477954162338'
on conflict (store_id,provider,order_id) do update
  set sale_id=excluded.sale_id, sku=excluded.sku, fee_cents=excluded.fee_cents,
      fee_source='actual', payout_cents=excluded.payout_cents;
update public.marketplace_email_sales m
set fee_cents=v.fee_cents,payout_cents=v.payout_cents,
    sale_id=o.sale_id,sku=o.sku,state='matched',reason=null
from depop_verified v join public.web_orders o on o.id=v.web_order_id
where m.store_id=o.store_id and m.marketplace='depop' and m.buyer->>'handle'=v.buyer_handle;

do $$
declare v_bad int;
begin
  select count(*) into v_bad from depop_verified v join public.web_orders o on o.id=v.web_order_id
  left join public.sales s on s.id=o.sale_id
  left join public.channel_orders c on c.store_id=o.store_id and c.provider='depop' and c.sale_id=o.sale_id
  where o.sale_id is null or c.sale_id is null or o.match_status<>'matched' or o.item_cents<>v.item_cents
    or o.marketplace_fee_cents<>v.fee_cents or s.price_cents<>v.item_cents
    or c.fee_cents<>v.fee_cents or c.fee_source<>'actual' or c.payout_cents<>v.payout_cents;
  if v_bad<>0 then raise exception 'Depop reconciliation verification failed for % rows',v_bad; end if;
end $$;

update public.marketplace_reconciliation_audit a set after_rows=jsonb_build_object(
  'web_orders',(select coalesce(jsonb_agg(to_jsonb(w) order by w.created_at),'[]'::jsonb) from public.web_orders w where w.id=v.web_order_id or w.sale_id=o.sale_id),
  'sales',(select to_jsonb(s) from public.sales s where s.id=o.sale_id),
  'channel_orders',(select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) from public.channel_orders c where c.sale_id=o.sale_id),
  'marketplace_email_sales',(select coalesce(jsonb_agg(to_jsonb(m)),'[]'::jsonb) from public.marketplace_email_sales m where m.sale_id=o.sale_id)
)
from depop_verified v join public.web_orders o on o.id=v.web_order_id
where a.store_id=o.store_id and a.provider='depop' and a.external_order_id=v.external_order_id;

commit;
