-- see file; applied via contents below
update public.channel_orders
set ship_label_cents = 4351,
    ship_label_source = 'ebay|pending:11021'
where provider = 'ebay'
  and order_id = '25-15245-74432';

update public.web_orders
set label_cost_cents = 4351
where payment_id = 'ebay:25-15245-74432'
   or order_no = '25-15245-74432';
