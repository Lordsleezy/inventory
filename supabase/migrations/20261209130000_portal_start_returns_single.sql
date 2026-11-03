-- Drop duplicate portal_start_returns overload (7-arg vs 8-arg caused 42725 in pgTAP/RPC).
begin;

drop function if exists public.portal_start_returns(jsonb, integer, text, text, text, boolean, integer);

commit;
