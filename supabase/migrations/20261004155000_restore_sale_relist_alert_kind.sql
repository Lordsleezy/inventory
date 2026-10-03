begin;

-- The web-shipping migration replaced this check and accidentally removed
-- the register's sale_relist alert kind.
alter table public.alert_outbox drop constraint if exists alert_outbox_kind_check;
alter table public.alert_outbox add constraint alert_outbox_kind_check
  check (kind in ('sale_delist','delist_nag','double_sell','sale_relist',
                 'web_order','web_shipped','web_apology'));

commit;
