# Metabase reporting (Legion server — not the iMac register)

## Docker (Legion)

```bash
cd /path/to/inventory/infra/metabase
cp .env.example .env   # set MB_DB_PASS, REPORTING_DATABASE_URL
docker compose up -d
```

Open http://legion:3000 (or the host port you mapped).

`REPORTING_DATABASE_URL` should use the `floor_reporting` role from migration `0026_reporting_role.sql`:

```
postgres://floor_reporting:PASSWORD@db.zoukmsmbztcuyoslvikp.supabase.co:5432/postgres?sslmode=require
```

After `0026` is applied on project **floor**:

```sql
alter role floor_reporting login password 'choose-a-strong-password';
```

## Starter questions (create in Metabase UI)

1. **Sales by day** — `report_sales_by_day` filtered to your `store_id`, last 30 days.  
2. **Tax collected by period** — sum `tax_cents` by month (CDTFA worksheet input).  
3. **Inventory aging** — `report_inventory_aging` sorted by `age_days` desc.  
4. **Sell-through by condition** — join sold units’ condition vs received (custom SQL).  
5. **Overrides / voids by clerk** — `sales` where `override_by is not null` or `voided_at is not null`, group by `actor_id`.

Export these as a Metabase collection once created; JSON dumps can live under `infra/metabase/questions/` later.

## Security

- Never point Metabase at `service_role` or the Supabase dashboard password for a writable user.  
- `floor_reporting` is SELECT-only on listed tables/views.  
- Do not run Metabase on the kiosk iMac.
