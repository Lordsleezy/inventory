-- Depop Money showed $467.86 while the Depop app showed $484.54.
-- Cause: SKU 99102 was typed with sale/fee/payout swapped. The Depop
-- sale-confirmation email has sale $28.00, fee $1.45, payout $26.55.
-- Also soft-delete depop_sale_entries whose linked sale is already voided,
-- and reject fee > sale on future inserts/updates.

begin;

-- Soft-delete entries tied to already-voided Depop sales (e.g. duplicate 99962).
update public.depop_sale_entries e
   set deleted_at = coalesce(e.deleted_at, now()),
       updated_at = now(),
       note = trim(both ' · ' from concat_ws(' · ', nullif(btrim(e.note), ''),
         'Soft-deleted: linked sale was voided (duplicate entry).'))
  from public.sales s
 where e.sale_id = s.id
   and e.deleted_at is null
   and s.voided_at is not null
   and lower(s.channel) = 'depop';

-- Fix 99102 (entry 428fca97-… / sale_id 134) from the known-bad swapped values only.
do $$
declare
  e public.depop_sale_entries;
  v_sale int := 2800;
  v_fee int := 145;
  v_payout int := 2655;
  v_deduct int;
  v_day date := date '2026-10-16';
  v_ticket text;
begin
  select * into e
    from public.depop_sale_entries
   where id = '428fca97-5ea9-413e-a31b-c4203e71ecb1'
     and deleted_at is null
   for update;
  if not found then
    raise notice 'depop 99102 entry not found — skip';
    return;
  end if;
  if e.sale_cents <> 2099 or e.fee_cents <> 2800 or e.payout_cents <> 145 then
    raise notice 'depop 99102 entry already changed — skip';
    return;
  end if;
  v_deduct := v_sale - v_payout;
  update public.sales
     set price_cents = v_sale,
         sold_at = public.depop_sold_at(v_day),
         note = trim(both ' · ' from concat_ws(' · ',
           coalesce(nullif(btrim(note), ''), 'Depop sale (entered by hand)'),
           'Corrected sale/fee/payout (were swapped).'))
   where id = e.sale_id;
  update public.channel_orders
     set item_cents = v_sale, fee_cents = v_deduct
   where sale_id = e.sale_id and provider = 'depop';
  update public.web_orders
     set item_cents = v_sale,
         total_cents = v_sale,
         marketplace_fee_cents = v_deduct,
         paid_at = public.depop_sold_at(v_day)
   where sale_id = e.sale_id;
  update public.depop_sale_entries
     set sale_cents = v_sale,
         fee_cents = v_fee,
         payout_cents = v_payout,
         sold_on = v_day,
         note = 'Corrected: fields were swapped (sale/fee/payout). Source: Depop sale-confirmation email.',
         updated_at = now()
   where id = e.id;
  v_ticket := coalesce((select ticket_id::text from public.sales where id = e.sale_id), 'sale:' || e.sale_id::text);
  perform public.portal_payout_refreeze(p_ticket_key := v_ticket);
end $$;

-- Prevent the swap that put the sale price into the fee box (fee $28 > sale $20.99).
create or replace function public.depop_sale_entries_fee_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.fee_cents is not null and new.sale_cents is not null and new.fee_cents > new.sale_cents then
    raise exception 'fee_exceeds_sale' using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists depop_sale_entries_fee_guard on public.depop_sale_entries;
create trigger depop_sale_entries_fee_guard
  before insert or update of sale_cents, fee_cents on public.depop_sale_entries
  for each row execute function public.depop_sale_entries_fee_guard();

commit;
