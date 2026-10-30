# Twin Rivers — Five New Sites Deployment Report

**Date:** 2026-10-21  
**Status:** Source built and verified locally. **GitHub repository creation blocked** for this Cloud Agent token (`createRepository` not permitted).  

## Summary table

| Domain | Intended GitHub URL | Build | Forms wired | Netlify ready |
|---|---|---|---|---|
| fencingwestsacramento.com | https://github.com/Lordsleezy/fencingwestsacramento-site | PASS (21 routes) | YES → hub `lead-ingest` | YES* |
| deckbuildingsacramento.com | https://github.com/Lordsleezy/deckbuildingsacramento-site | PASS (16 routes) | YES → hub `lead-ingest` | YES* |
| gateinstallationsacramento.com | https://github.com/Lordsleezy/gateinstallationsacramento-site | PASS (16 routes) | YES → hub `lead-ingest` | YES* |
| citrusheightsfencing.com | https://github.com/Lordsleezy/citrusheightsfencing-site | PASS (21 routes) | YES → hub `lead-ingest` | YES* |
| fencessacramentoca.com | https://github.com/Lordsleezy/fencessacramentoca-site | PASS (24 routes) | YES → hub `lead-ingest` | YES* |

\*Netlify-ready means `netlify.toml`, functions, and build succeed. Owner must still create Netlify sites, DNS, and update hub allowlist. Forms cannot be end-to-end verified until Netlify + hub allowlist are live.

## Unresolved issues

1. **Cannot create GitHub repos** with current Cloud Agent integration token (`GraphQL: Resource not accessible by integration (createRepository)`). Source lives in `twin-rivers-new-sites/repos/*` on this branch. Run `publish-to-github.sh` with a token that has `repo` create permission, or create five empty public repos then push.
2. **Hub allowlist not updated** (existing seven sites preserved). `twinriversfence.com` `lead-ingest` `ALLOWED_DOMAINS` must add the five new hostnames or leads may not attribute/accept correctly.
3. **Turnstile keys** not set — forms include Turnstile widget when `TURNSTILE_SITE_KEY` is provided at build/deploy time.
4. **No live Netlify deploy** (per instructions).
5. **Form delivery** not proven against production ingest from these new hosts (requires deploy + allowlist).

## Exact Netlify settings (all five)

| Setting | Value |
|---|---|
| Base directory | repo root |
| Build command | `node build.mjs` |
| Publish directory | `dist` |
| Node version | `20` (set in `netlify.toml`) |
| Functions directory | `netlify/functions` |
| Edge functions | `netlify/edge-functions` (`block-forms` on `/*`) |

## Required environment variables (names only)

| Variable | Required? | Notes |
|---|---|---|
| `TURNSTILE_SITE_KEY` | Recommended | Public site key injected into HTML at build |
| `LEAD_FAIL_OPEN_WEBHOOK` | Optional | Fail-open alert if hub ingest unreachable |
| `URL` / `DEPLOY_PRIME_URL` | Auto (Netlify) | Used by `contact-lead` for origin/dead-letter |

Hub-side secrets (on twinriversfence.com, not in these repos) may include Turnstile secret and ingest gate — do not commit.

## Owner approvals needed

1. Approve GitHub repo creation / run `publish-to-github.sh` with elevated token.  
2. Approve Netlify site creation + Cloudflare DNS (owner-handled).  
3. Approve hub `lead-ingest` allowlist update for five new domains.  
4. Confirm deck & gate marketing claims remain accurate (already present on twinriversfence.com / city sites).  
5. Review `fencessacramentoca.com` doorway mitigation (metro/commercial focus + city-site directory) before indexing.  
6. Do not submit sitemaps for indexing until review complete.

## Recommended deployment order

1. Create/push GitHub repos.  
2. Update hub lead allowlist.  
3. Deploy **fencingwestsacramento-site** + **citrusheightsfencing-site** (clearest city analogues).  
4. Deploy **deckbuildingsacramento-site** + **gateinstallationsacramento-site** (specialty).  
5. Deploy **fencessacramentoca-site** last after doorway-structure review.  
6. Smoke-test one real lead per site (phone + form) before Search Console submit.

## Architecture foundation

Best technical foundation: **`Lordsleezy/granitebay-site`** (static generator, Netlify functions, River chat lead flow, schema/layout). Existing seven production sites were **not** modified.

## Doorway risk (Sacramento fencing)

`fencessacramentoca.com` is intentionally **not** a clone of Folsom/Roseville/etc. It targets City of Sacramento neighborhoods + commercial/multifamily and links to dedicated city sites. Still review before indexing.
