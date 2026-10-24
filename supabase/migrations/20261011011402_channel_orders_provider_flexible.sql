-- Align channel_orders.provider with production: any lowercase marketplace slug
alter table public.channel_orders drop constraint if exists channel_orders_provider_check;
alter table public.channel_orders
  add constraint channel_orders_provider_check
  check (provider ~ '^[a-z][a-z0-9_]{0,39}$');