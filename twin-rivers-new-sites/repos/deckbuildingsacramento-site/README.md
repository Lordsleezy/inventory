# Sacramento Deck Builders

Static marketing site for **Twin Rivers Fence** — decks focus.

- **Domain (planned):** https://deckbuildingsacramento.com
- **Business:** Twin Rivers Fence
- **Phone:** (916) 906-2254
- **License:** #1089233
- **Hours:** Monday–Friday, 8 AM–5 PM
- **Parent:** https://twinriversfence.com/

## Stack

- Custom Node static site generator (`build.mjs`)
- Netlify publish directory: `dist`
- Lead form → `/.netlify/functions/contact-lead` → hub `lead-ingest` on twinriversfence.com

## Commands

```bash
npm run build
npm start   # serves dist on :4173
```

## Netlify settings (owner will configure)

| Setting | Value |
|---|---|
| Build command | `node build.mjs` |
| Publish directory | `dist` |
| Node version | `20` |

### Environment variables (names only)

| Name | Purpose |
|---|---|
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key (public) |
| `TURNSTILE_SECRET_KEY` | Used on hub ingest if configured there |
| `LEAD_FAIL_OPEN_WEBHOOK` | Optional fail-open alert webhook |
| `URL` / `DEPLOY_PRIME_URL` | Provided by Netlify at runtime |

## Owner actions required after deploy

1. Create Netlify site and connect GitHub repo (do not done by this agent).
2. Point Cloudflare DNS for `deckbuildingsacramento.com` to Netlify.
3. **Update hub allowlist** on `twinriversfence.com` `lead-ingest` to include `deckbuildingsacramento.com` (required for lead delivery).
4. Add Search Console / analytics when ready — not configured here.
5. Do not submit for indexing until content review is complete.


## Capability note

Deck services are already offered on twinriversfence.com and existing city sites (decks/patios IA). This specialty site deepens deck-focused marketing for Sacramento.


## Verified claims only

This site does not invent street addresses, review counts, awards, or project totals.
