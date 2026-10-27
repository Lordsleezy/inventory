-- portal_set_unit_text raised unit_not_found for every plain text field (description, brand, model, category, condition, upc):
-- it tested FOUND after a dynamic EXECUTE ... INTO, and EXECUTE does not set FOUND. So a generated description from item edit
-- never saved. Test the unit row directly instead. Nothing else in the function changes.
begin;
do $$
declare
  v_def text;
  v_new text;
  v_old constant text := E'into v_old using v_store, p_sku;\n  if not found then raise exception ''unit_not_found''';
  v_fix constant text := E'into v_old using v_store, p_sku;\n  if not exists (select 1 from public.units where store_id = v_store and sku = p_sku) then raise exception ''unit_not_found''';
begin
  v_def := pg_get_functiondef('public.portal_set_unit_text(text, text, text)'::regprocedure);
  if position(v_old in v_def) = 0 then raise exception 'portal_set_unit_text: expected FOUND check not found'; end if;
  v_new := replace(v_def, v_old, v_fix);
  -- The edit event names the admin from staff (auth.users.email is not readable in every environment).
  v_new := replace(v_new, 'coalesce((select email from auth.users where id = auth.uid()), ''admin'')',
    'coalesce((select s.display_name from public.staff s where s.user_id = auth.uid() limit 1), ''admin'')');
  execute v_new;
end $$;
commit;
