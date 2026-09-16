# Floor

Commercial inventory + POS for liquidation and resale stores. Capacitor 8 iPhone
app, Supabase as the source of truth, Netlify functions for OAuth, alerts, and
Square tokens.

This repo is the product. A store's public website lives in a separate repo and
reads `public.public_items` filtered by `store_id`.

**License:** UNLICENSED. Do not commit `.env`, phone backups, or the service role.

The Surface / InvenTree stack is under `legacy/` and is not the product.

---

## What is in this repo

| Path | Role |
|---|---|
| `apps/mobile` | Phone UI (Vite + React) |
| `apps/adapter` | Capacitor iOS host |
| `packages/store` | On-device SQLite cache + backup format |
| `packages/cloud` | Supabase client, sell RPCs, import |
| `packages/payments` | Cash + card stub |
| `packages/channels` | Channel helpers |
| `packages/square-plugin` | Square SDK skeleton (compiles; not wired to the reader yet) |
| `supabase/migrations` | 0001–0009 |
| `netlify/` | Functions site (OAuth, Resend, Square token) |
| `codemagic.yaml` | TestFlight IPA |

---

## First store (your phone)

1. Push to `master` applies `supabase/migrations` 0001–0009 on project **floor**
   (`https://zoukmsmbztcuyoslvikp.supabase.co`). Confirm under Database → Migrations.
2. Auth → Email on. Site URL `https://inventoryobi.netlify.app`. Redirect URLs
   must include `https://inventoryobi.netlify.app/auth/confirmed`. Install a
   TestFlight build that includes this code.
3. **Sign up in the app**. If confirm-email is on, check your inbox, then sign in.
   A signed-in account with no store lands on **Create your store**. Copy **STORE_ID** from Setup.
4. Import the phone backup. Refuses if that store already has units:

```bash
set SUPABASE_URL=https://zoukmsmbztcuyoslvikp.supabase.co
set SUPABASE_SERVICE_ROLE=...
set STORE_ID=the-uuid-from-setup
node --experimental-strip-types scripts/import-phone-backup.mjs path\to\floor-backup-full.json
node --experimental-strip-types scripts/verify-photos.mjs
```

5. Set a manager PIN in Setup.

---

## Netlify functions site

This is **not** the store website. It is the OAuth / Resend / Square-token backend.

Create it once:

1. Open [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import an existing project** → GitHub.
2. Authorize GitHub if asked, then pick **`Lordsleezy/inventory`** (private is fine).
3. Site name anything you like (example: `floor-functions`).
4. Leave **Base directory** empty. The site deploys from the **repository root**.
5. Build settings (also in `netlify.toml` at the repo root — Netlify will read this):
   - **Build command:** `npm install --prefix netlify --omit=dev`
   - **Publish directory:** `netlify/public`
   - **Functions directory:** `netlify/functions`
6. Branch: **`master`**. Deploy.
7. Site settings → Environment variables → add every key in `docs/PHONE.md` (Supabase, CONNECTIONS_KEY, Resend, OAuth, Square/eBay/Amazon).
8. Copy the site URL (no trailing slash) into Codemagic group **appstore** as `VITE_FUNCTIONS_URL`, e.g. `https://floor-functions.netlify.app`.
9. Register this callback on Square, eBay, and Amazon:

`https://<your-functions-site>/.netlify/functions/oauth-callback`

Functions live in **`netlify/functions/`**. Shared helpers live in **`netlify/lib/`**. The static publish folder is **`netlify/public/`** (a placeholder page, not a store site). `dispatch-alerts` also runs on a 5-minute schedule.

---

## iOS / TestFlight

Codemagic workflow **Floor iOS**, repo `Lordsleezy/inventory`, branch `master`,
group **appstore**. Bundle ID `com.openboxindustries.floor` (keep for this
TestFlight; a generic App Store id is a later change).

```bash
git tag ios-cloud-1
git push origin ios-cloud-1
```

Or start a build of `master` from the Codemagic dashboard.

`appstore` group must include `CERTIFICATE_PRIVATE_KEY`, `VITE_SUPABASE_URL`
(`https://zoukmsmbztcuyoslvikp.supabase.co`), `VITE_SUPABASE_ANON_KEY`,
`VITE_FUNCTIONS_URL`.
