begin;

-- The visual matcher now handles new units after their first own photo.
drop trigger if exists units_queue_model_enrichment on public.units;
drop trigger if exists photos_queue_model_enrichment on public.photos;

commit;
