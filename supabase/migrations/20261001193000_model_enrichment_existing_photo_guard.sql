begin;

create or replace function public.queue_model_enrichment()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_brand text; v_model text; v_photo_model text; v_store uuid; v_sku text;
begin
  if tg_table_name='photos' then
    select u.brand,u.model,coalesce(u.listing_specs->>'matched_model',u.model),u.store_id,u.sku
      into v_brand,v_model,v_photo_model,v_store,v_sku
      from public.units u where u.store_id=new.store_id and u.sku=new.sku;
  else
    v_brand:=new.brand; v_model:=new.model; v_store:=new.store_id; v_sku:=new.sku;
    v_photo_model:=coalesce(new.listing_specs->>'matched_model',new.model);
  end if;
  if nullif(btrim(v_model),'') is not null
    and exists(select 1 from public.photos p where p.store_id=v_store and p.sku=v_sku)
    and not exists(select 1 from public.manufacturer_photos mp
      where lower(mp.brand)=lower(v_brand) and lower(mp.model)=lower(v_photo_model)) then
    insert into public.model_enrichment(brand_key,model_key,brand,model,status)
    values(lower(btrim(v_brand)),lower(btrim(v_model)),btrim(v_brand),btrim(v_model),
      case when v_model ~ '^[A-Za-z0-9/.-]{5,}$' and v_model ~ '[0-9]'
        then 'pending' else 'needs_model' end)
    on conflict (brand_key,model_key) do nothing;
  end if;
  return new;
end $$;

commit;
