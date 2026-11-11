begin;
select no_plan();

select ok(not public.valid_gtin('499993873522'), 'a Costco 4999 item number is not a GTIN');
select ok(public.valid_gtin('012345678905'), 'a real UPC-A still validates');
select ok(public.valid_gtin(''), 'a blank UPC still means unset');

select * from finish();
rollback;
