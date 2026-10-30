begin;

-- The eBay taxonomy paths are stored with a leading "Root >" segment. Strip
-- it for ranking so real retail categories outrank Baby and collectible leaves.
create or replace function public.portal_category_search(p_channel text,p_query text,p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
 st uuid:=coalesce(public.portal_store_id(),public.current_store_id());
 raw_query text:=lower(btrim(coalesce(p_query,'')));
 normalized_query text; result jsonb;
begin
 if st is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
 if p_channel='depop' then
   return coalesce((select jsonb_agg(to_jsonb(x)) from (
     select category_id,path,required_fields from public.store_depop_categories
     where store_id=st and active and (raw_query='' or path ilike '%'||raw_query||'%' or category_id=raw_query)
     order by path limit least(greatest(coalesce(p_limit,30),1),100)
   ) x),'[]'::jsonb);
 end if;
 normalized_query:=regexp_replace(raw_query,'(picture|photo)\s+frames?','frame','gi');
 normalized_query:=regexp_replace(normalized_query,'candle\s+holders?','candle','gi');
 if normalized_query ~ '^[0-9]+$' then
   return coalesce((select jsonb_agg(to_jsonb(x)) from (
     select category_id,path,required_fields from public.channel_taxonomy
     where channel=p_channel and active and leaf and category_id=normalized_query limit 1
   ) x),'[]'::jsonb);
 end if;
 with terms as (
   select distinct token from unnest(regexp_split_to_array(normalized_query,'[^a-z0-9]+')) token
   where length(token)>=3 and token not in ('the','and','for','with','from','new','used','set','each','item','product','home','brand','size')
 ), candidates as (
   select t.category_id,t.path,t.required_fields,
     regexp_replace(t.path,'^Root\s*>\s*','','i') as rank_path,
     (select count(*)::int from terms z where t.path ilike '%'||z.token||'%') match_score
   from public.channel_taxonomy t
   where t.channel=p_channel and t.active and t.leaf
     and (raw_query='' or exists(select 1 from terms z where t.path ilike '%'||z.token||'%'))
 ), ranked as (
   select c.*,
     case when rank_path ~* '^(Home & Garden|Consumer Electronics|Electronics|Clothing, Shoes & Accessories|Business & Industrial|Health & Beauty|Sporting Goods|Books( & Magazines)?|Computers/Tablets & Networking|Cell Phones & Accessories|Toys & Hobbies)( >|$)' then 0 else 1 end mainstream_rank,
     case when rank_path ~* '^(Baby|Collectibles)( >|$)|(^| > )(Fandom|Anime|Manga|Character|Disney|Marvel|Star Wars|Pok[eé]mon)( >|$)' then 1 else 0 end niche_rank
   from candidates c
 )
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into result from (
   select category_id,path,required_fields from ranked
   order by niche_rank,mainstream_rank,match_score desc,path
   limit least(greatest(coalesce(p_limit,30),1),100)
 ) x;
 return result;
end $$;
revoke all on function public.portal_category_search(text,text,integer) from public,anon;
grant execute on function public.portal_category_search(text,text,integer) to authenticated,service_role;

-- Count one-off SKU rows directly. For stocked SKUs count their intake ledger
-- movements instead; this preserves quantities after sales, giveaways and
-- defects without counting returns or merged aliases twice. Pulled-defective
-- child SKUs are a transfer of an existing unit, not a new receipt.
create or replace function public.portal_inventory_received_total()
returns bigint language plpgsql stable security definer set search_path=public as $$
declare st uuid:=public.portal_store_id(); total bigint;
begin
 if st is null or not public.portal_is_admin() then
   raise exception 'portal_access_denied' using errcode='42501';
 end if;
 select
   (select count(*)::bigint
      from public.units u
     where u.store_id=st and not u.is_test and not coalesce(u.is_stocked,false)
       and not exists (
         select 1 from public.events e
          where e.store_id=u.store_id and e.kind='stock_pulled_defective'
            and e.note='New defective one-of-one SKU '||u.sku
       ))
   + coalesce((select sum(m.quantity_delta)::bigint
      from public.stock_movements m
      join public.units u on u.store_id=m.store_id and u.sku=m.sku
     where m.store_id=st and not u.is_test and u.is_stocked
       and m.movement_type in ('opening_balance','received','added')
       and m.quantity_delta>0),0)
 into total;
 return total;
end $$;
revoke all on function public.portal_inventory_received_total() from public,anon;
grant execute on function public.portal_inventory_received_total() to authenticated;

commit;
