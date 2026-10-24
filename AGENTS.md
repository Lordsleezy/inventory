# Production database migrations

The live Supabase project is `floor`. Work from the current `master` branch when releasing database changes.

- Never apply a migration to the live database from an unmerged branch.
- Merge the migration file into `master` before applying it. In the same work session, confirm the file is committed and pushed to `master`, apply it through the normal migration workflow, and verify that the live migration ledger and `master` agree.
- Do not use `supabase migration repair --status reverted` to hide drift. Investigate the live schema and migration ledger, recover the original SQL when possible, and test against a copy of live before changing production.
- Do not deploy backend or admin from a dirty checkout or a commit behind `origin/master`; use `scripts/lib/deploy-guard.mjs`.
