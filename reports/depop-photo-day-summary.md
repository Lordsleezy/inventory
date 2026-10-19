# Photo-day Depop export

- Cohort: 116 first-photo-today SKUs
- Depop **allow**: 101 (none already listed_on depop)
- Depop **block**: 15 (powered / policy strikes / charger / missing)
- Ask total (allow): $3,238.49
- Files: `OpenBox-Depop-PhotoDay-2026-10-19.csv`, `OpenBox-Depop-PhotoDay-Blocked-2026-10-19.csv`

## Publish blocker
Floor has **no Depop listing API**. Vendoo and Depop seller sessions are **not logged in** in this environment (confirmed via browser).

To get these live: log into Vendoo (or Depop selling) in this Cloud Agent browser, then ask to resume the push using `OpenBox-Depop-PhotoDay-2026-10-19.csv`.

Do **not** mark `listed_on` until items are actually live on Depop.
