-- Receive condition chips: New, Open box, Used - Good, Used - Fair (replace Excellent / Good / Fair).
update public.store_settings
set value = '["New","Open box","Used - Good","Used - Fair","For parts"]'::jsonb
where key = 'conditions';
