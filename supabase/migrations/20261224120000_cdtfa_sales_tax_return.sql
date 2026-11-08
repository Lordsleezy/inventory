-- California sales tax worksheet (CDTFA-401-A). Reporting only.
-- A void is not a sale and not a return. Marketplace sales stay in total
-- sales and are deducted as other (marketplace facilitator). Floor never files.

create table if not exists public.cdtfa_return_snapshots (
  period_id uuid primary key references public.books_periods(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  month_start date not null,
  facts jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.cdtfa_return_snapshots enable row level security;
revoke all on public.cdtfa_return_snapshots from public, anon, authenticated;

create or replace function public.cdtfa_dollars(p_cents bigint)
returns integer language sql immutable as $$
  select round(coalesce(p_cents, 0) / 100.0)::int;
$$;

create or replace function public.cdtfa_period_facts(p_store uuid, p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_remitted text[];
begin
  v_remitted := public.setting_text_array(p_store, 'tax_remitted_channels');
  return (
    with base as (
      select l.id,
        (l.sold_at at time zone 'America/Los_Angeles')::date as sold_on,
        (l.voided_at at time zone 'America/Los_Angeles')::date as voided_on,
        l.sku,
        coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(btrim(u.title), ''), 'SKU ' || l.sku) as title,
        lower(l.channel) as channel,
        coalesce(l.price_cents, 0) + coalesce(l.shipping_cents, 0) as measure_cents,
        coalesce(l.tax_cents, 0) as tax_cents,
        l.voided_at,
        o.fulfillment,
        nullif(btrim(concat_ws(', ', nullif(btrim(o.ship_city), ''), nullif(btrim(o.ship_region), ''), nullif(btrim(o.ship_postal), ''))), '') as ship,
        nullif(btrim(o.ship_region), '') as ship_region,
        case
          when lower(l.channel) = any (coalesce(v_remitted, array[]::text[]))
            or coalesce(l.tax_remitted_by, '') = 'marketplace'
            or lower(l.channel) in ('ebay', 'depop', 'mercari', 'tiktok', 'amazon', 'poshmark')
            then 'marketplace'
          when public.sale_channel_is_in_store(l.channel) or lower(coalesce(o.fulfillment, '')) = 'pickup'
            then 'taxable'
          when nullif(btrim(o.ship_region), '') is null then 'missing_state'
          when upper(btrim(o.ship_region)) in ('CA', 'CALIFORNIA') then 'taxable'
          else 'interstate'
        end as bucket
      from public.sale_ledger l
      left join lateral (
        select w.fulfillment, w.ship_city, w.ship_region, w.ship_postal
        from public.web_orders w where w.sale_id = l.id order by w.created_at limit 1
      ) o on true
      left join public.units u on u.store_id = l.store_id and u.sku = l.sku
      where l.store_id = p_store
        and (
          (l.voided_at is null and (l.sold_at at time zone 'America/Los_Angeles')::date between p_start and p_end)
          or (
            l.voided_at is not null
            and (l.voided_at at time zone 'America/Los_Angeles')::date between p_start and p_end
            and (l.sold_at at time zone 'America/Los_Angeles')::date < p_start
          )
          or l.id in (
            select ret.sale_id from public.return_refunds f
            join public.returns ret on ret.id = f.return_id and ret.store_id = p_store
            where f.store_id = p_store and f.refunded_on between p_start and p_end and ret.sale_id is not null
          )
        )
    ),
    sales as (
      select id, sold_on, sku, title, channel, measure_cents, tax_cents, bucket, ship
      from base
      where voided_at is null and sold_on between p_start and p_end
    ),
    adjustments as (
      select 'refund'::text as kind, b.id, f.refunded_on as sold_on, b.sku, b.title, b.channel,
        f.amount_cents as measure_cents, 0 as tax_cents, b.bucket, b.ship,
        (b.voided_at is not null) as voided
      from public.return_refunds f
      join public.returns ret on ret.id = f.return_id and ret.store_id = p_store
      join base b on b.id = ret.sale_id
      where f.store_id = p_store and f.refunded_on between p_start and p_end
      union all
      select 'prior_void', id, voided_on, sku, title, channel, measure_cents, tax_cents, bucket, ship, true
      from base
      where voided_at is not null and voided_on between p_start and p_end and sold_on < p_start
    )
    select jsonb_build_object(
      'sales', coalesce((select jsonb_agg(to_jsonb(s) order by s.sold_on, s.id) from sales s), '[]'::jsonb),
      'adjustments', coalesce((select jsonb_agg(to_jsonb(a) order by a.sold_on, a.id) from adjustments a), '[]'::jsonb)
    )
  );
end $$;
revoke all on function public.cdtfa_period_facts(uuid, date, date) from public, anon, authenticated;

create or replace function public.portal_cdtfa_filing()
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.books_require_admin();
  v_value text;
begin
  v_value := nullif(public.store_setting(v_store, 'cdtfa_filing_frequency', '"quarterly"'::jsonb) #>> '{}', '');
  if v_value not in ('monthly', 'quarterly', 'yearly') then v_value := 'quarterly'; end if;
  return v_value;
end $$;
revoke all on function public.portal_cdtfa_filing() from public, anon;
grant execute on function public.portal_cdtfa_filing() to authenticated;

create or replace function public.portal_set_cdtfa_filing(p_frequency text)
returns text language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.books_require_admin();
begin
  if p_frequency not in ('monthly', 'quarterly', 'yearly') then
    raise exception 'invalid_filing_frequency' using errcode = '22023';
  end if;
  insert into public.store_settings (store_id, key, value)
  values (v_store, 'cdtfa_filing_frequency', to_jsonb(p_frequency))
  on conflict (store_id, key) do update set value = excluded.value;
  return p_frequency;
end $$;
revoke all on function public.portal_set_cdtfa_filing(text) from public, anon;
grant execute on function public.portal_set_cdtfa_filing(text) to authenticated;

create or replace function public.portal_cdtfa_return(p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.books_require_admin();
  v_cursor date;
  v_month_end date;
  v_facts jsonb;
  v_snap jsonb;
  v_locked boolean;
  v_all_locked boolean := true;
  v_any_month boolean := false;
  v_legacy boolean := false;
  v_months jsonb := '[]'::jsonb;
  v_sales jsonb := '[]'::jsonb;
  v_adj jsonb := '[]'::jsonb;
  s jsonb;
  a jsonb;
  v_gross bigint := 0;
  v_market bigint := 0;
  v_inter bigint := 0;
  v_section_b bigint := 0;
  v_collected bigint := 0;
  v_market_count int := 0;
  v_missing int := 0;
  v_rate_count int := 0;
  v_sale_rows jsonb := '[]'::jsonb;
  v_market_rows jsonb := '[]'::jsonb;
  v_inter_rows jsonb := '[]'::jsonb;
  v_tax_rows jsonb := '[]'::jsonb;
  v_b_rows jsonb := '[]'::jsonb;
  v_missing_rows jsonb := '[]'::jsonb;
  v_rate_rows jsonb := '[]'::jsonb;
  v_bucket text;
  v_measure bigint;
  v_expected int;
  v_line1 int; v_line3 int; v_line8 int; v_line10 int; v_b3 int; v_line11 int; v_line12 int;
  v_state int; v_county int; v_local int; v_district int := 0; v_line17 int; v_line18 int; v_line19 int; v_line21 int;
  v_collected_dollars int;
  v_due date;
  v_today date := (timezone('America/Los_Angeles', now()))::date;
  v_open boolean;
  v_address_ok boolean;
  v_rate_ok boolean;
  v_ready boolean;
  v_freq text;
begin
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;
  v_freq := public.portal_cdtfa_filing();
  v_cursor := date_trunc('month', p_start)::date;
  while v_cursor <= p_end loop
    v_any_month := true;
    v_month_end := (v_cursor + interval '1 month' - interval '1 day')::date;
    v_locked := exists (
      select 1 from public.books_periods bp
      where bp.store_id = v_store and bp.period_type = 'month'
        and bp.period_start = v_cursor and bp.status = 'locked'
    );
    if not v_locked then v_all_locked := false; end if;
    v_snap := null;
    if v_locked and p_start <= v_cursor and p_end >= v_month_end then
      select sn.facts into v_snap from public.cdtfa_return_snapshots sn
      where sn.store_id = v_store and sn.month_start = v_cursor;
      if v_snap is null then v_legacy := true; end if;
    end if;
    if v_snap is null then
      v_facts := public.cdtfa_period_facts(
        v_store,
        greatest(p_start, v_cursor),
        least(p_end, v_month_end)
      );
    else
      v_facts := v_snap;
    end if;
    v_months := v_months || jsonb_build_array(jsonb_build_object(
      'month', v_cursor, 'locked', v_locked, 'snapshotted', v_snap is not null
    ));
    v_sales := v_sales || coalesce(v_facts->'sales', '[]'::jsonb);
    v_adj := v_adj || coalesce(v_facts->'adjustments', '[]'::jsonb);
    v_cursor := (v_cursor + interval '1 month')::date;
  end loop;

  for s in select value from jsonb_array_elements(v_sales) loop
    v_bucket := s->>'bucket';
    v_measure := coalesce((s->>'measure_cents')::bigint, 0);
    v_gross := v_gross + v_measure;
    v_sale_rows := v_sale_rows || jsonb_build_array(s);
    if v_bucket = 'marketplace' then
      v_market := v_market + v_measure;
      v_market_count := v_market_count + 1;
      v_market_rows := v_market_rows || jsonb_build_array(s);
    elsif v_bucket = 'interstate' then
      v_inter := v_inter + v_measure;
      v_inter_rows := v_inter_rows || jsonb_build_array(s);
    else
      v_tax_rows := v_tax_rows || jsonb_build_array(s);
      if v_bucket = 'taxable' then
        v_collected := v_collected + coalesce((s->>'tax_cents')::bigint, 0);
        v_expected := round(v_measure::numeric * 0.0725)::int;
        if abs(coalesce((s->>'tax_cents')::int, 0) - v_expected) > 1 then
          v_rate_count := v_rate_count + 1;
          v_rate_rows := v_rate_rows || jsonb_build_array(s);
        end if;
      else
        v_missing := v_missing + 1;
        v_missing_rows := v_missing_rows || jsonb_build_array(s);
      end if;
    end if;
  end loop;

  for a in select value from jsonb_array_elements(v_adj) loop
    v_bucket := a->>'bucket';
    if coalesce(a->>'voided', 'false') = 'true' and a->>'kind' = 'refund' then
      continue;
    end if;
    if v_bucket in ('taxable', 'missing_state') then
      v_section_b := v_section_b + coalesce((a->>'measure_cents')::bigint, 0);
      v_b_rows := v_b_rows || jsonb_build_array(a);
    end if;
  end loop;

  v_line1 := public.cdtfa_dollars(v_gross);
  v_line3 := v_line1;
  v_line8 := public.cdtfa_dollars(v_inter);
  v_line10 := public.cdtfa_dollars(v_market);
  v_b3 := public.cdtfa_dollars(v_section_b);
  v_line11 := v_line8 + v_line10 + v_b3;
  v_line12 := v_line3 - v_line11;
  v_state := round(v_line12 * 0.06)::int;
  v_county := round(v_line12 * 0.0025)::int;
  v_local := round(v_line12 * 0.01)::int;
  v_line17 := v_state + v_county + v_local + v_district;
  v_collected_dollars := public.cdtfa_dollars(v_collected);
  v_line18 := greatest(v_collected_dollars - v_line17, 0);
  v_line19 := v_line17 + v_line18;
  v_line21 := v_line19;
  v_due := (date_trunc('month', p_end) + interval '2 months' - interval '1 day')::date;
  v_open := p_end >= v_today;
  v_address_ok := v_missing = 0;
  v_rate_ok := v_rate_count = 0 and v_collected_dollars + 1 >= v_line17;
  v_ready := v_address_ok and v_rate_ok and not v_open;

  return jsonb_build_object(
    'form', 'CDTFA-401-A REV. 126 (1-26)',
    'frequency', v_freq,
    'period_start', p_start,
    'period_end', p_end,
    'due_on', v_due,
    'due_note', 'If that day is a Saturday, Sunday, or state holiday, CDTFA accepts the next business day. Floor does not file this return.',
    'open', v_open,
    'locked', v_any_month and v_all_locked,
    'legacy_lock', v_legacy,
    'ready', v_ready,
    'place', 'Penryn, unincorporated Placer County. Statewide rate 7.25% (state 6.00%, county 0.25%, local 1.00%). No district tax at the store.',
    'months', v_months,
    'gross_cents', v_gross,
    'marketplace_cents', v_market,
    'marketplace_count', v_market_count,
    'interstate_cents', v_inter,
    'section_b_cents', v_section_b,
    'collected_cents', v_collected,
    'lines', jsonb_build_array(
      jsonb_build_object('id','1','label','Total sales','dollars',v_line1,'cents',v_gross,'note','Every sale that still stands, including marketplace and shipments outside California. Price plus shipping the buyer paid. Sales tax is not in this line. Voids are left out.','sales',v_sale_rows),
      jsonb_build_object('id','2','label','Purchases subject to use tax','dollars',0,'cents',0,'note','Floor does not record purchases for use tax.','sales','[]'::jsonb),
      jsonb_build_object('id','3','label','Total (add lines 1 and 2)','dollars',v_line3,'cents',v_gross,'note','Line 1 plus line 2, rounded to the nearest dollar the way the return adds.','sales','[]'::jsonb),
      jsonb_build_object('id','4','label','Sales to other retailers for resale','dollars',0,'cents',0,'note','No resale certificates are recorded in Floor.','sales','[]'::jsonb),
      jsonb_build_object('id','5','label','Nontaxable sales of food products','dollars',0,'cents',0,'note','No food-product exemption is recorded.','sales','[]'::jsonb),
      jsonb_build_object('id','6','label','Nontaxable labor (repair and installation)','dollars',0,'cents',0,'note','No nontaxable labor is recorded.','sales','[]'::jsonb),
      jsonb_build_object('id','7','label','Sales to the United States government','dollars',0,'cents',0,'note','No United States government sales are recorded.','sales','[]'::jsonb),
      jsonb_build_object('id','8','label','Sales in interstate or foreign commerce','dollars',v_line8,'cents',v_inter,'note','Website and register shipments outside California. Marketplace sales are not deducted here. They are deducted on line 10.','sales',v_inter_rows),
      jsonb_build_object('id','9','label','Sales tax included on line 1 (if any)','dollars',0,'cents',0,'note','Line 1 is the pre-tax price. Tax Floor collected is not inside line 1, so this deduction is zero.','sales','[]'::jsonb),
      jsonb_build_object('id','10','label','Other deductions — marketplace facilitator sales','dollars',v_line10,'cents',v_market,'note','eBay, TikTok Shop, Amazon, Depop, Mercari, and Poshmark. The same sales are included in line 1. The marketplace collects and pays that tax. CDTFA still wants them in total sales, then deducted here.','sales',v_market_rows),
      jsonb_build_object('id','A11','label','Total Section A (add lines 4 through 10)','dollars',v_line8+v_line10,'cents',null,'note','Resale, food, labor, government, and tax-included lines are zero.','sales','[]'::jsonb),
      jsonb_build_object('id','B1','label','Bad debt losses on taxable sales','dollars',0,'cents',0,'note','No bad-debt deduction is recorded.','sales','[]'::jsonb),
      jsonb_build_object('id','B2','label','Cost of tax-paid purchases resold prior to use','dollars',0,'cents',0,'note','No tax-paid purchases resold are recorded.','sales','[]'::jsonb),
      jsonb_build_object('id','B3','label','Returned taxable merchandise','dollars',v_b3,'cents',v_section_b,'note','Refunds logged on a sale that still stands, plus a taxable sale from an earlier period that was voided this period. Same-period voids are left out of line 1 instead. Marketplace refunds are not deducted again.','sales',v_b_rows),
      jsonb_build_object('id','B4','label','Cash discounts on taxable sales','dollars',0,'cents',0,'note','No cash-discount deduction is recorded.','sales','[]'::jsonb),
      jsonb_build_object('id','B5','label','Total Section B (add lines 1 through 4)','dollars',v_b3,'cents',null,'note','Only returned taxable merchandise has an amount.','sales','[]'::jsonb),
      jsonb_build_object('id','11','label','Total nontaxable transactions (Section A plus Section B)','dollars',v_line11,'cents',null,'note','This is page 1, line 11. It is the sum of the rounded deduction lines.','sales','[]'::jsonb),
      jsonb_build_object('id','12','label','Transactions subject to tax (subtract line 11 from line 3)','dollars',v_line12,'cents',null,'note','Website and register sales shipped or handed over in California, after returns. Sales with no ship-to state stay here until the address is filled in.','sales',v_tax_rows),
      jsonb_build_object('id','13','label','State tax 6.00 percent','dollars',v_state,'cents',null,'note','Line 12 times 0.0600, rounded to the nearest dollar.','sales','[]'::jsonb),
      jsonb_build_object('id','14','label','County tax 1/4 percent','dollars',v_county,'cents',null,'note','Line 12 times 0.0025, rounded to the nearest dollar. Placer County is included in the statewide 7.25%.','sales','[]'::jsonb),
      jsonb_build_object('id','15','label','Local tax 1.00 percent','dollars',v_local,'cents',null,'note','Line 12 times 0.01, rounded to the nearest dollar.','sales','[]'::jsonb),
      jsonb_build_object('id','16','label','District tax','dollars',0,'cents',0,'note','Penryn has no district tax. Open Box is under the $500,000 California-sales threshold and ships by common carrier, so destination district tax is not required. Schedule A2 line A2/A3 equals line 12. Line A4 is zero.','sales','[]'::jsonb),
      jsonb_build_object('id','17','label','Total state, county, local, and district tax','dollars',v_line17,'cents',null,'note','Add lines 13, 14, 15, and 16. Each line was already rounded, so this can differ by about a dollar from 7.25% of line 12.','sales','[]'::jsonb),
      jsonb_build_object('id','18','label','Excess tax collected','dollars',v_line18,'cents',null,'note','Tax Floor collected on the taxable sales, to the nearest dollar, minus line 17, when Floor collected more than the return computes. Sales more than one cent off 7.25% are listed here.','sales',v_rate_rows),
      jsonb_build_object('id','19','label','Total tax amount','dollars',v_line19,'cents',null,'note','Line 17 plus line 18.','sales','[]'::jsonb),
      jsonb_build_object('id','20a','label','Credit for current period partial exemptions','dollars',0,'cents',0,'note','No partial exemptions are recorded.','sales','[]'::jsonb),
      jsonb_build_object('id','20b','label','Credit for prior period tax recovery','dollars',0,'cents',0,'note','No Schedule Q recovery is recorded.','sales','[]'::jsonb),
      jsonb_build_object('id','20c','label','Credit for tax paid to other states','dollars',0,'cents',0,'note','No other-state tax credit is recorded.','sales','[]'::jsonb),
      jsonb_build_object('id','20d','label','Credit for aircraft common carrier partial exemption','dollars',0,'cents',0,'note','Does not apply.','sales','[]'::jsonb),
      jsonb_build_object('id','20e','label','Total credit','dollars',0,'cents',0,'note','Lines 20a through 20d.','sales','[]'::jsonb),
      jsonb_build_object('id','21','label','Net tax','dollars',v_line21,'cents',null,'note','Line 19 minus line 20e. This is the tax the return says is due before prepayments.','sales','[]'::jsonb),
      jsonb_build_object('id','22','label','Less tax prepayments','dollars',0,'cents',0,'note','No CDTFA prepayments are recorded in Floor.','sales','[]'::jsonb),
      jsonb_build_object('id','23','label','Net tax less prepayments','dollars',v_line21,'cents',null,'note','Line 21 minus line 22.','sales','[]'::jsonb),
      jsonb_build_object('id','24','label','Penalty','dollars',0,'cents',0,'note','Left at zero. Penalty applies only if the human files after the due date.','sales','[]'::jsonb),
      jsonb_build_object('id','25','label','Interest','dollars',0,'cents',0,'note','Left at zero. Interest applies only if the payment is late.','sales','[]'::jsonb),
      jsonb_build_object('id','26','label','Total amount due and payable','dollars',v_line21,'cents',null,'note','Line 23. Penalty and interest stay zero until a person files late.','sales','[]'::jsonb)
    ),
    'schedule_a2', jsonb_build_object(
      'a1', v_line12,
      'a2', v_line12,
      'a4', 0,
      'note', 'All taxable transactions are subject only to the 7.25% statewide rate. Enter line 12 on Schedule A2 line A1 and on A2/A3. Line A4 is zero, so district tax on line 16 is zero.'
    ),
    'checks', jsonb_build_array(
      jsonb_build_object('id','collected','ok',v_rate_ok,'detail',
        format('Floor collected %s on taxable California sales. The return computes %s on lines 13 through 16. Excess tax on line 18 is %s. %s sale%s differ from 7.25%% by more than one cent.',
          to_char(v_collected / 100.0, 'FM$999,999,990.00'),
          to_char(v_line17, 'FM$999,999,990') || '.00',
          to_char(v_line18, 'FM$999,999,990') || '.00',
          v_rate_count, case when v_rate_count = 1 then '' else 's' end),
        'sales', v_rate_rows),
      jsonb_build_object('id','marketplace','ok',true,'detail',
        format('%s marketplace sale%s, %s, are in line 1 and again on line 10. None of them stay in taxable sales.',
          v_market_count, case when v_market_count = 1 then '' else 's' end,
          to_char(v_market / 100.0, 'FM$999,999,990.00'))),
      jsonb_build_object('id','returns','ok',true,'detail',
        format('Returned taxable merchandise is %s. Voids inside this period are omitted from line 1. Marketplace refunds are not deducted a second time.',
          to_char(v_section_b / 100.0, 'FM$999,999,990.00'))),
      jsonb_build_object('id','addresses','ok',v_address_ok,'detail',
        case when v_missing = 0 then 'Every shipped sale that we would tax has a ship-to state.'
          else format('%s shipped sale%s have no ship-to state. They are still counted as taxable until someone enters the state. They are listed in red.',
            v_missing, case when v_missing = 1 then '' else 's' end) end,
        'sales', v_missing_rows)
    ),
    'signer', jsonb_build_object('name','','title','','date','','email','','phone','','preparer','Floor')
  );
end $$;
revoke all on function public.portal_cdtfa_return(date, date) from public, anon;
grant execute on function public.portal_cdtfa_return(date, date) to authenticated;

-- Freeze a month's facts when Books locks that month. Unlock drops the freeze.
create or replace function public.portal_books_finalize(p_period uuid, p_report jsonb, p_excel_base64 text, p_pdf_base64 text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.books_require_admin(); p public.books_periods; v_hash text;
begin
 select * into p from public.books_periods where id=p_period and store_id=v_store for update;
 if not found or p.status='locked' then raise exception 'period_not_editable' using errcode='P0001'; end if;
 if p.period_type<>'month' then raise exception 'weekly_period_cannot_lock' using errcode='P0001'; end if;
 if p_excel_base64 is null or p_pdf_base64 is null or length(p_excel_base64)>30000000 or length(p_pdf_base64)>30000000 then raise exception 'frozen_exports_required' using errcode='22023'; end if;
 v_hash:=encode(digest(convert_to(p_report::text,'UTF8'),'sha256'),'hex');
 insert into public.books_period_versions(store_id,period_id,version_no,locked_at,locked_by,snapshot_hash,frozen_report,frozen_excel,frozen_pdf)
 values(v_store,p.id,coalesce((select max(ver.version_no)+1 from public.books_period_versions ver where ver.period_id=p.id),1),now(),auth.uid(),v_hash,p_report,decode(p_excel_base64,'base64'),decode(p_pdf_base64,'base64'));
 update public.books_periods set status='locked',locked_at=now(),locked_by=auth.uid(),frozen_report=p_report,
   frozen_excel=decode(p_excel_base64,'base64'),frozen_pdf=decode(p_pdf_base64,'base64') where id=p.id;
 insert into public.cdtfa_return_snapshots(period_id, store_id, month_start, facts)
 values (p.id, v_store, p.period_start, public.cdtfa_period_facts(v_store, p.period_start, p.period_end))
 on conflict (period_id) do update set facts = excluded.facts, month_start = excluded.month_start, created_at = now();
 insert into public.books_period_audit(store_id,period_id,action,reason,actor_id,snapshot_hash) values(v_store,p.id,'locked','',auth.uid(),v_hash);
end $$;

create or replace function public.portal_books_unlock(p_period uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.books_require_admin(); p public.books_periods;
begin
 if length(btrim(coalesce(p_reason,'')))<8 then raise exception 'unlock_reason_required' using errcode='22023'; end if;
 select * into p from public.books_periods where id=p_period and store_id=v_store for update;
 if not found or p.status<>'locked' then raise exception 'period_not_locked' using errcode='P0001'; end if;
 update public.books_periods set status='ready',locked_at=null,locked_by=null,frozen_report=null,frozen_excel=null,frozen_pdf=null where id=p.id;
 delete from public.cdtfa_return_snapshots where period_id = p.id;
 insert into public.books_period_audit(store_id,period_id,action,reason,actor_id,snapshot_hash) values(v_store,p.id,'unlocked',btrim(p_reason),auth.uid(),encode(digest(convert_to(coalesce(p.frozen_report,'{}'::jsonb)::text,'UTF8'),'sha256'),'hex'));
end $$;
