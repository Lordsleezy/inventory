# Netlify readiness — Sacramento Deck Builders

| Item | Value |
|---|---|
| GitHub repository | https://github.com/Lordsleezy/deckbuildingsacramento-site |
| Framework | Custom Node static generator |
| Build command | `node build.mjs` |
| Publish directory | `dist` |
| Node version | 20 |
| Edge functions | `block-forms` on `/*` |
| Functions | `contact-lead`, `google-reviews` |
| Required env | `TURNSTILE_SITE_KEY` (recommended) |
| Optional env | `LEAD_FAIL_OPEN_WEBHOOK` |
| Ready for deploy | YES — after Netlify site + DNS + hub allowlist update |

**Not done by agent:** Netlify project creation, Cloudflare DNS, indexing.
