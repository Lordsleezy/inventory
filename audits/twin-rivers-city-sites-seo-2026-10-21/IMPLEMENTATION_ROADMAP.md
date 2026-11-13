# Implementation Roadmap — Twin Rivers City Network Growth

**Date:** 2026-10-21  
**Rule:** No production changes, domain purchases, or paid subscriptions from this research agent. Estimates are relative complexity/cost impact, not calendar durations.

**Legend**  
- Complexity: S / M / L  
- OpEx: $ ≈ free–low tooling; $$ = modest SaaS/API; $$$ = significant ongoing  
- Impact: Low / Med / High on qualified leads or SEO clarity  

---

## Phase 1 — Critical SEO repairs

| Task | Complexity | Dependencies | OpEx | Impact |
|---|---|---|---|---|
| Restore Git access or monorepo for city site sources | M | Owner GitHub | $ | High (enables all fixes) |
| Install GA4 (or GTM) on all 7 domains + tel/form events | S | GA property | $ | High |
| Complete NAP in schema/footer with **one verified address** | S | Confirm HQ address | $ | High (local trust) |
| Hub: noindex or 301 satellite-city `/services/*-{city}/` to city domains | M | Hub deploy approval | $ | High (doorway/dupe risk) |
| Align Maps/`sameAs` with real GBP strategy (one HQ vs service areas) | M | GBP access | $ | High |
| Remove or 301 Granite Bay sibling city service-areas to dedicated domains | S | granitebay-site | $ | Med |
| Verify claims (“40+ years”) accuracy | S | Owner | $ | Med (compliance) |
| LCP pass: hero image, defer River chat on mobile | M | City builds | $ | Med |

**Exit criteria:** Analytics live; hub no longer indexes competing satellite city money pages; schema NAP complete.

---

## Phase 2 — Search visibility & analytics integration

| Task | Complexity | Dependencies | OpEx | Impact |
|---|---|---|---|---|
| Verify all 7 domains in Google Search Console; submit sitemaps | S | GSC access | $ | High |
| Cloud Agent / env: GSC read-only API or MCP | M | Google Cloud OAuth | $ | High |
| 28d / prior / 90d baseline report (real positions & queries) | S | GSC | $ | High |
| Call tracking numbers per city (optional) | M | Vendor | $$ | Med–High |
| GBP optimization: categories, services, photos, review velocity (HQ) | M | Owner time | $ | High |
| Citation consistency audit (CSLB, directories, BuildZoom) | S | Manual | $ | Med |
| Money-page internal linking pass (repair, HOA, gates) | M | Content | $ | Med |
| CrUX / Search Console Core Web Vitals monitoring | S | GSC | $ | Med |

**Exit criteria:** Know exact top queries/pages per city; organic→lead attribution working.

**Domain expansion gate:** Do **not** buy cities until Phase 2 shows ≥1 city with sustained organic clicks + measurable leads for 60–90 days.

---

## Phase 3 — AI SEO intelligence

| Task | Complexity | Dependencies | OpEx | Impact |
|---|---|---|---|---|
| Nightly technical auditor (Actions + Lighthouse) | M | Repos | $ | High |
| Keyword gap clustering from GSC | M | Phase 2 | $ | High |
| Similarity gate across sister sites | M | Corpus | $ | Med (spam defense) |
| AI draft briefs → Git PR only | M | LLM + facts pack | $–$$ | Med–High |
| Weekly Cloud Agent digest (`subscribe_timer`) | S | Cloud Agent | $ | Med |
| Competitor SERP membership alerts (5×5 terms) | M | SERP API optional | $–$$ | Med |

**Exit criteria:** Weekly prioritized fix list with evidence; zero auto-publishes.

---

## Phase 4 — AI lead generation

### Inbound

| Task | Complexity | Dependencies | OpEx | Impact |
|---|---|---|---|---|
| AI qualify River/chat + forms (service, footage, HOA, timeline) | M | lead-ingest | $ | High |
| Lead routing rules by city/job type | S | SMS/email | $$ | High |
| Follow-up sequences with human takeover | M | CRM/Twilio | $$ | High |
| Offline conversion upload to GA4/Ads (if ads later) | M | Phase 2 | $ | Med |

### Proactive (Sentinel Prospects)

| Task | Complexity | Dependencies | OpEx | Impact |
|---|---|---|---|---|
| Confirm Prospects deploy + Supabase for fence filters | M | sentinelprospect | $ | High |
| Daily fencing_bidable queue for Sac/Placer | M | Collectors | $ | High |
| Human approve → outreach template (GC/developer) | M | Process | $ | High |
| Feed commercial/temp fence leads to Twin Rivers admin | M | Integration | $ | Med–High |

**Exit criteria:** Inbound leads scored/routed; ≥N fencing-relevant public opportunities reviewed weekly without spam.

---

## Phase 5 — Multi-city scaling & automation

| Task | Complexity | Dependencies | OpEx | Impact |
|---|---|---|---|---|
| Decide consolidate vs keep multi-domain using Phase 2 data | L | GSC+leads | $ | Critical |
| If consolidate: 301 weak cities → hub `/fencing/{city}/` | L | Legal/brand | $ | High long-term |
| If keep: expand **content depth** on winners only (Folsom/Roseville first) | M | Phase 3 | $ | High |
| New city domains **only if** thresholds met (below) | L | Budget | $$ | Conditional |
| Full Local Growth admin in Sentinel UI | L | Architecture doc | $–$$ | Med |
| Scheduled multi-agent research + PR factory | M | Cloud Agents | $–$$ | Med |

### Expansion thresholds (suggested)

Buy/build a new city domain only when **all** are true:

1. Existing network has GSC baselines.  
2. At least two cities show organic clicks + ≥1 tracked lead/month each for 90 days.  
3. Hub overlap/doorway issues resolved.  
4. New city has distinct demand **and** capacity to serve.  
5. Plan is either (a) landing page on hub, or (b) full unique site with photos/reviews — not a thin clone.

**Default recommendation today:** **Wait — do not buy more city domains.**

---

## Suggested build order (first concrete system)

1. GA4 + GSC (Phase 1–2 measurement).  
2. Hub indexation cleanup (Phase 1).  
3. Technical auditor Action (Phase 3).  
4. Lead qualification on existing River/forms (Phase 4 inbound).  
5. Prospects fencing queue (Phase 4 outbound).  

This sequence minimizes spend and maximizes learning before architecture bets.
