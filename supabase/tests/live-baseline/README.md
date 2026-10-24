# Live schema baseline

`schema.sql` is a schema-only dump of the **live** Floor database (no rows), `roles.sql` its custom roles
(no passwords), and `applied-versions.txt`
lists the migration versions live has applied (`supabase_migrations.schema_migrations`).

CI (`sql-tests` › *Live baseline*) and `npm run test:migrations:live` start a Supabase-image Postgres,
load `schema.sql`, then apply every file in `supabase/migrations` whose version is **not** in
`applied-versions.txt`, in filename order. If a new migration would fail against what live really has,
this job fails.

Refresh it (someone with live access, from master, after applying migrations):

```bash
SUPABASE_DB_URL=postgres://... bash scripts/refresh-live-baseline.sh   # or `supabase link` first and omit the URL
git add supabase/tests/live-baseline && git commit -m "chore(db): refresh live schema baseline"
```

The script refuses to finish if the dump contains anything that looks like a key or token.
Until the first baseline is committed the CI job is skipped with a warning.

The older PGlite / pgTAP jobs are a **historical fresh replay** from an empty database. They are kept
to keep a from-scratch install working, but they do not represent live.
