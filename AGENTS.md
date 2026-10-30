# Production

Merge to master. Never push to or merge into release. Never run netlify deploy, the Netlify CLI deploy, or scripts/deploy-prod-netlify.mjs. Never apply migrations to live. Production updates once a day at 6 AM via the release job, or when Paul runs Release now.

In your report, say "merged to master, ships at the next release" instead of claiming it's live.

Manual Netlify deploys stay disabled unless `FLOOR_EMERGENCY_DEPLOY=yes-paul-approved`. That flag is only for Paul-approved emergency recovery.

# Production database migrations

The live Supabase project is `floor`. Agents never apply migrations to live. The release job does, from `master`, before it fast-forwards `release`.

- Put the migration file on `master` through a pull request. Do not run `supabase db push` against the live project.
- CI on `master` still runs migration replay, pgTAP, the live-baseline check, and the test suite. A red check blocks that day's release.
- Do not use `supabase migration repair --status reverted` to hide drift. Investigate the live schema and migration ledger, recover the original SQL when possible, and test against a copy of live before changing production.
- Do not deploy backend or admin from a dirty checkout. Production deploys come from the `release` branch only.

# Depop listing agents

After every confirmed Depop publication, call the service-role floor_depop_record_listing RPC and verify the canonical listings row before publishing the next item. See docs/depop-listing-agent.md. Never mark a draft as listed, and never retry publication when only tracker confirmation failed.
