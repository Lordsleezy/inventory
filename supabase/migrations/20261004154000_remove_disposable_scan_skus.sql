begin;

-- Historical test ledger cleanup already ran in production. Fresh replays
-- leave SKU history intact; automatic allocation now ignores the reserved range.

commit;
