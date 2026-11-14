-- Floor receive must never fail because eBay category / required specifics are incomplete.
-- Keep the helper for callers that still perform it; unfinished rows stay visible via
-- portal_ebay_needs_fix (missing category or required specifics).

create or replace function public.receive_require_ebay_leaf(p_extras jsonb)
returns void
language plpgsql
stable
as $$
begin
  -- Soft gate: receiving into Floor is the priority. eBay gaps are flagged after save.
  return;
end $$;

revoke all on function public.receive_require_ebay_leaf(jsonb) from public, anon;
grant execute on function public.receive_require_ebay_leaf(jsonb) to authenticated, service_role;

comment on function public.receive_require_ebay_leaf(jsonb) is
  'No-op soft gate. eBay leaf/specifics are no longer required to commit a Floor receive.';
