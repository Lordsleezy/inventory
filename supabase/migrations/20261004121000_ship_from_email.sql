-- Shippo requires an email on the label's from-address.
update public.store_settings
   set value = value || '{"email":"paul@sentinelprime.org"}'::jsonb
 where key = 'ship_from' and not (value ? 'email');
