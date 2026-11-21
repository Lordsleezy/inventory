# Sentinel Local Growth Engine — Proposed Architecture

**Date:** 2026-10-21  
**Goal:** Centralize monitoring, SEO intelligence, lead attribution, and Prospects integration for the Twin Rivers city-site network — with human approval before publish.  
**Constraint:** Prefer existing Sentinel infrastructure; avoid unnecessary new SaaS.

---

## 1. Where this should live

| Option | Fit | Verdict |
|---|---|---|
| **Floor / `inventory` repo (current Cloud Agent workspace)** | Commercial POS/liquidation — unrelated domain | **Do not build SEO product here** (reports-only OK) |
| **`sentinelprospect`** | Already has permits, companies, maps, Supabase, fence bidability | **Best home for proactive B2B lead intelligence** |
| **`twinrivers` Netlify hub** | Already central lead ingest + city allowlist | **Best home for inbound lead ledger + site attribution** |
| **New `sentinel-local-growth` app** | Clean slate | Only if Prospects + hub cannot share a thin BFF |
| **`sentinelprime` / dashboard** | Command-center UX | Good **UI shell** later; not data plane first |

**Recommendation:**  
- **Inbound + SEO metrics plane:** extend Twin Rivers hub (Netlify functions + small admin UI) or a thin module that reads GSC/GA4.  
- **Outbound construction intelligence:** extend Sentinel Prospects.  
- **Orchestration / scheduled research:** Cursor Cloud Agents + GitHub Actions.  
- **Shared store:** Supabase project dedicated to Sentinel (reactivate/extend `SentinelAI` or Prospects’ Supabase — not Floor).

---

## 2. Logical architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Sources                                                    │
│  City sites (Netlify) │ Hub twinriversfence.com             │
│  GSC │ GA4 │ GBP Insights │ Call tracking │ Lead forms      │
│  Sentinel Prospects collectors (permits, SAM.gov, …)        │
│  SERP samples (WebSearch / SERP API) │ Lighthouse CI        │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Ingest & normalize (Netlify fn / Actions / collectors)     │
│  - search_performance_daily (query, page, city, clicks…)    │
│  - tech_audit_runs (url, LCP, broken, schema_errors…)       │
│  - leads (existing lead-ingest + enrichment)                │
│  - opportunities (fencing_bidable permits/projects)         │
│  - competitor_snapshots                                     │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Supabase (Sentinel)                                        │
│  RLS for staff; service role for jobs only                  │
└───────────────┬─────────────────────────────────────────────┘
                │
        ┌───────┴────────┐
        ▼                ▼
┌───────────────┐  ┌──────────────────────────────────────────┐
│ Growth Admin  │  │ AI workers (Cursor Agent / LLM jobs)     │
│ KPI dashboards│  │ - keyword gap briefs                     │
│ Lead inbox    │  │ - content drafts → Git PR (approval)     │
│ Opp queue     │  │ - weekly narrative report                │
│ Audit diffs   │  │ - NEVER direct prod publish              │
└───────────────┘  └──────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  Publish path: PR → human review → Netlify deploy           │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Core services

### 3.1 Search performance service

- Poll GSC Search Analytics for all 7 properties daily.  
- Dimensions: query, page, device, country; custom map page→city_site.  
- Store impressions, clicks, CTR, position.  
- Alert: click drop >X% WoW on money pages.

### 3.2 Technical auditor

- Nightly crawl of sitemap URLs (or sample + money pages).  
- Lighthouse mobile on homes + top 10 landing pages.  
- Overlap report: hub URLs targeting satellite cities still `index,follow`.

### 3.3 Lead intelligence (inbound)

- Keep `lead-ingest` as source of truth.  
- Enrich with GA4 client_id / session if available.  
- AI qualification fields: intent, service type, urgency, HOA, commercial vs residential.  
- Route: SMS to owner + optional city crew tag.

### 3.4 Opportunity intelligence (outbound)

- Reuse Prospects `fencing_bidable` + contact enrichment.  
- Queue UI: approve → “create estimate task” / export CSV.  
- No auto-spam.

### 3.5 Content factory (gated)

- Input: GSC gap + approved fact pack (NAP, license, services).  
- Output: markdown draft PR against city repo.  
- Similarity gate vs sister sites (reject if Jaccard too high).

---

## 4. Tooling map

| Tool | Role |
|---|---|
| Cursor Cloud Agents | Research, draft PRs, weekly digests |
| `subscribe_timer` | Schedule audits when agent free |
| GitHub Actions | Deterministic crawls/Lighthouse |
| Netlify Functions | Leads, reviews, future GSC proxy with secrets |
| Supabase | Metrics + opportunities store |
| Playwright / Chromium | Optional local SERP screenshots (human geo) |
| MCP (future) | GSC, GA4, Netlify — configure in **cloud** env |

---

## 5. Automation vs human judgment

| Automated | Human required |
|---|---|
| Data pull, scoring, alerts | Domain consolidation decision |
| Tech issue tickets | Content publish |
| Draft generation | Pricing & bid decisions |
| Lead scoring | Customer conversations |
| Permit matching | Outreach tone / relationships |

---

## 6. Security & compliance

- Secrets only in Netlify/GitHub Actions/Cloud env — never in static HTML.  
- Rotate any documented default admin passwords on hub.  
- TCPA for SMS; CAN-SPAM for email.  
- Public records OK; no bypass of paywalled/private data.  
- Don’t fabricate locations for GBP.

---

## 7. Minimal viable “Local Growth” slice

1. GA4 + GSC on all domains.  
2. Supabase tables: `gsc_daily`, `tech_audits`, `leads_mirror`.  
3. Hub admin page: KPI cards by city.  
4. Weekly Cloud Agent report → Slack/email.  
5. Prospects fence queue link-out.

This yields an AI-operated **measurement and recommendation** system before any multi-city content automation.
