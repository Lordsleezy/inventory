# Cloud Agent MCP Capability Report

**Audit date:** 2026-10-21  
**Cloud Agent run:** [City site SEO AI growth](https://cursor.com/agents/bc-01a15c5b-5403-7471-8177-29e6e6e98f3a)  
**Workspace repo:** `github.com/Lordsleezy/inventory` (Floor / commercial inventory POS — not the fencing sites)  
**Egress:** unrestricted for this environment  

---

## Executive finding

**Local Cursor MCP integrations are not automatically available to this Cloud Agent.** Only MCPs configured for the cloud environment appear here. This audit proceeded with GitHub CLI (scoped), public web research, live HTTP fetches, Lighthouse, and Supabase MCP — not Google Search Console, GA4, Netlify admin, Ads Keyword Planner, or Google Business Profile APIs.

---

## 1. Integrations operational in this Cloud Agent

| Integration | Status | Evidence / notes |
|---|---|---|
| **GitHub (read via `gh` + git)** | Partial | Authenticated to `Lordsleezy` org for listed public repos. Can clone `twinrivers`, `granitebay-site`, `sentinelprospect`, etc. Cannot resolve `rocklin-site`, `roseville-site`, `folsom-site`, `elkgrove-site`, `grassvalley-site` (404 / not found). |
| **Supabase MCP** | Ready | `list_projects` succeeded. Visible projects: `floor` (ACTIVE_HEALTHY), `SentinelAI` (INACTIVE). No Twin Rivers / GSC tables observed. |
| **WebSearch (Cursor native)** | Ready | Used for live Google-result research (tool-mediated SERPs, not personal browser). |
| **WebFetch (Cursor native)** | Ready | Fetched live pages and Google spam-policy docs. |
| **Browser / Chromium + Lighthouse** | Ready | `google-chrome` + `npx lighthouse` available; mobile audits run for Rocklin, Folsom, Grass Valley, hub. |
| **Shell / curl** | Ready | Live HTTP, robots, sitemaps, TTFB, headers. |
| **cursor-cloud diagnostics** | Ready | `run-info`, `environment-info`. |
| **cursor-subscriptions** | Ready | Includes `subscribe_timer` (cron/delay) — enables scheduled follow-up prompts on this agent when free. |
| **computerUse subagent** | Available | Browser automation subagent type exists; not required for this research pass. |

---

## 2. Integrations unavailable (not connected in cloud)

| Integration | Status | Impact on this audit |
|---|---|---|
| **Google Search Console** | Not present | No impressions, clicks, CTR, average position, indexing coverage, or query/page reports. |
| **Google Analytics 4** | Not present | No sessions, conversions, or attribution. Sites also have **no GA4/GTM snippets** on live HTML. |
| **Google Ads Keyword Planner** | Not present | No official search-volume data. |
| **Google Business Profile API** | Not present | Could not pull review counts, Q&A, or Insights. Sites link one shared Maps short URL. |
| **Netlify admin / API MCP** | Not present | Hosting confirmed via response headers (`server: Netlify`); no deploy logs, form submissions, or bandwidth metrics. |
| **Sentinel Prospects MCP** | Not present | Researched via public GitHub clone only. |
| **Slack / Linear / Datadog / etc.** | Not in this run’s MCP catalog for business SEO | N/A |

---

## 3. What requires separate cloud configuration

To unlock the blocked research layers, configure **Cloud Agent environment** MCP / secrets (not Desktop MCP alone):

1. **Search Console** — Google Cloud OAuth client + GSC property access for all 7 domains; MCP or service account with `webmasters.readonly`.
2. **GA4** — Measurement IDs on sites + Analytics Data API credentials in cloud env.
3. **Netlify** — Personal access token with site read for twinrivers + city sites; optional form/lead export.
4. **GBP** — Business Profile API with location ownership verified for Twin Rivers Fence.
5. **City site Git remotes** — Restore or grant access to `*-site` repos (currently 404), or document that sources live only in Netlify deploys / other remotes.
6. **Keyword Planner** — Google Ads developer token + MCC access (optional; DataForSEO/other APIs are alternatives).

---

## 4. Credentials / permissions (no secrets exposed)

- GitHub token is present for this workspace’s `inventory` remote; it does **not** unlock the five named city-site repos.
- Supabase MCP can list org projects; do not assume fencing lead DBs exist there.
- No GSC/GA4/Netlify tokens were found or used.
- Twin Rivers README mentions a default admin password pattern in docs — **not repeated here**; rotate if still live.

---

## 5. Can the Cloud Agent conduct live Google search research?

**Yes, with limitations.**

- **Available:** Cursor `WebSearch` returns ranked organic links + snippets for queries. Useful for competitor identification and rough visibility.
- **Not available:** Personalized local SERPs, exact Maps/local-pack slots, “People Also Ask” fidelity, ads vs organic separation always, or stable absolute positions.
- **Method used this audit:** WebSearch from cloud egress, date **2026-10-21**, device/context = tool backend (not a Rocklin/Roseville residential IP). Positions are **observed tool SERP order**, not Search Console average position.

---

## 6. Are automated scheduled SEO audits technically possible?

**Yes, partially, today:**

| Mechanism | Feasibility | Notes |
|---|---|---|
| `cursor-subscriptions` → `subscribe_timer` (cron) | High | Can enqueue recurring audit prompts on this Cloud Agent when idle. |
| GitHub Actions in city/hub repos | High | Crawl + Lighthouse + sitemap diff on schedule; needs repo access. |
| Netlify scheduled functions | Medium | Good for lead digests / sitemap ping; not full SERP intelligence. |
| Full GSC-driven weekly report | Blocked until GSC cloud auth | Highest business value once connected. |

Reliable automation: technical crawl, uptime, sitemap health, Lighthouse budgets, lead volume by `source_domain`.  
Requires human judgment: content strategy, doorway-risk architecture, GBP reputation, publishing approval.

---

## 7. Inventory of dynamic namespaces actually seen

From tool discovery on this run:

- `cursor` (AwaitShell, Task, WebSearch, WebFetch, …)
- `cursor-cloud`
- `cursor-subscriptions`
- `Supabase`

**Not seen:** Google, Netlify, Search Console, Analytics, Ads, GBP, Sentinel-specific MCPs.

---

## 8. Recommendation for next cloud setup (minimal)

1. Add GSC read-only MCP/API for all seven domains.  
2. Install GA4 on all sites with a shared property + `source_domain` custom dimension.  
3. Restore GitHub access to city-site source repos (or consolidate into one private monorepo).  
4. Optional: Netlify token for deploy/form telemetry.  
5. Keep Desktop MCPs for interactive work; mirror only needed ones into Cloud Agent env.
