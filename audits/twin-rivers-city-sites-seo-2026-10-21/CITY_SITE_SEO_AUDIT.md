# City Site SEO Audit — Twin Rivers Fence Network

**Audit date:** 2026-10-21  
**Scope:** Live production sites + accessible source (`Lordsleezy/twinrivers`, `Lordsleezy/granitebay-site`)  
**Constraint:** Research only — no production changes  
**Named repos unavailable:** `rocklin-site`, `roseville-site`, `folsom-site`, `elkgrove-site`, `grassvalley-site` return GitHub 404 for this agent  

---

## Network inventory (verified live)

| Brand surface | Production domain | HTTP | Host | Sitemap URLs | robots.txt |
|---|---|---|---|---|---|
| Rocklin | https://rocklinfencing.com/ | 200 | Netlify | 62 | Allow all + sitemap |
| Roseville | https://rosevillefencingca.com/ | 200 | Netlify | 81 | Allow all + sitemap |
| Folsom | https://folsomfencing.com/ | 200 | Netlify | 73 | Allow all + sitemap |
| Elk Grove | https://elkgrovefencing.com/ | 200 | Netlify | 78 | Allow all + sitemap |
| Grass Valley | https://grassvalleyfencing.com/ | 200 | Netlify | 102 | Allow all + sitemap |
| Granite Bay | https://granitebayfencing.com/ | 200 | Netlify (+ Cloudflare on some edges) | 83 | Allow all + sitemap |
| Hub / brand | https://twinriversfence.com/ | 200 | Netlify + Cloudflare | 180 | Allow all + sitemap |

**Repository name ≠ domain:** The five requested `*-site` GitHub repos are not accessible. Live domains were discovered via public search + hub config (`twinrivers/src/data/site.mjs` `dedicatedCitySites`).

**Architecture (from accessible code):**

- **Hub:** Static HTML tree + Node SEO generators + Netlify Functions (`lead-ingest`).
- **City satellites (Granite Bay confirmed; others match pattern):** Custom static generator (`build.mjs` → `dist/`), Netlify publish, `contact-lead` → hub `lead-ingest`.
- **Shared business identity:** CA license `#1089233`, phone `(916) 906-2254`, one Google Maps short link across sites.

---

## Cross-network findings (severity ranked)

### CRITICAL

| ID | Finding | Evidence | Recommended fix |
|---|---|---|---|
| C1 | **No analytics / conversion tracking on any checked homepage** | Regex scan of all 7 homes: no GA4, GTM, CallRail, Clarity, Plausible, Facebook Pixel | Install one GA4 property (or GTM) on all domains; stream `source_domain`, `form_name`, UTM; add call-click events on `tel:` |
| C2 | **Incomplete NAP in LocalBusiness schema** | Schema `PostalAddress` has locality/region/country only — **no streetAddress / postalCode** on city sites or hub | Publish one verified service-area address (or Grass Valley HQ from BuildZoom: 21030 Home Camp Rd) consistently in schema + footer if accurate |
| C3 | **Hub still indexes large city×service matrix alongside dedicated city domains** | Hub sitemap: **104** `/services/*` URLs including `/services/wood-fence-installation-rocklin/` with `robots: index,follow` while Rocklin has its own domain | 301 or noindex hub `/services/*-{satellite-city}/` and `/fencing/{satellite}/` leftovers toward city money pages; keep unique non-satellite towns on hub only |
| C4 | **Doorway / scaled-content policy risk** | Google doorway abuse examples include multiple city domains + similar pages funneling to one business ([spam policies](https://developers.google.com/search/docs/essentials/spam-policies#doorway-pages)). Network uses 7 domains, shared phone/license/Maps, generator scaffolds, homepage paragraph token Jaccard **0.35–0.61** between cities | Prefer consolidating authority onto `twinriversfence.com` + strong `/fencing/{city}/` **or** keep cities only if each has clearly unique, useful local content + distinct GBP strategy; stop expanding domains until GSC proves ROI |

### HIGH

| ID | Finding | Evidence | Recommended fix |
|---|---|---|---|
| H1 | **Missing street-level credibility vs competitors** | Fantastic Fence / Cal-Sierra / Build Rite publish physical addresses; Twin Rivers city schemas do not | Add real address, service hours, CSLB link, insurance proof, project photos with EXIF-stripped local captions |
| H2 | **Single GBP Maps URL reused on every city schema `sameAs` / `hasMap`** | Same `maps.app.goo.gl/rXBxsJXV2E6Z3Luu6` on Rocklin, Roseville, Folsom, Elk Grove, Grass Valley, Granite Bay | Align schema `hasMap` with the **actual** GBP that should rank for that city; do not fabricate multiple fake locations |
| H3 | **City source repos inaccessible** | GitHub 404 for five `*-site` remotes documented in July 2026 network report | Restore remotes or monorepo so audits/fixes are version-controlled |
| H4 | **Sister-site footer linking on every city homepage** | Each city home links to all other city domains + hub | Keep one disclosure to Twin Rivers parent; reduce cross-city keyword-adjacent footer rings (already partially mitigated vs older keyword rings) |
| H5 | **Granite Bay still generates sibling-city service-area pages** | `/service-areas/rocklin/` live with `noindex,follow` — good — but content overlaps Rocklin domain topics | Prefer 301 to `rocklinfencing.com` instead of maintaining parallel noindex pages |

### MEDIUM

| ID | Finding | Evidence | Recommended fix |
|---|---|---|---|
| M1 | **LCP ~3.5–3.7s mobile (lab)** | Lighthouse mobile 2026-10-21: Rocklin perf 80 / LCP 3.6s; Folsom 86 / 3.5s; Grass Valley 85 / 3.5s; Hub 87 / 3.7s | Optimize hero media, defer non-critical JS (chat widget), WebP, font subsetting |
| M2 | **Hub homepage much heavier** | Hub HTML ~144KB vs city ~31–36KB | Slim hub home; move chat CSS/JS out of critical path |
| M3 | **Decks/patios sections on fence city sites** | Multiple city sitemaps include 7 decks + 7 patios URLs | Keep only if you actually sell those services in that city; else noindex or remove to avoid topical dilution |
| M4 | **Claims consistency** | “40+ years” network-wide; prior internal doc flagged verification needed | Confirm legally accurate claims before amplifying in AI content |
| M5 | **No call tracking numbers** | Direct `tel:+19169062254` only | Optional CallRail/CallTrackingMetrics per city for ROI proof |

### LOW / POSITIVE

| ID | Finding | Evidence |
|---|---|---|
| P1 | Valid self-canonicals on city homes | e.g. Rocklin canonical = `https://rocklinfencing.com/` |
| P2 | robots.txt + sitemap present everywhere | All 7 domains 200 |
| P3 | www → apex and http → https 301s | Verified for all domains |
| P4 | LocalBusiness + FenceContractor + FAQ schema on city homes | Present; types parse |
| P5 | Lead pipeline exists | City `contact-lead` → hub `lead-ingest` with domain allowlist |
| P6 | Lighthouse SEO category 100 | Rocklin, Folsom, Grass Valley, hub (lab) |
| P7 | Local copy differentiators exist | Neighborhood/soil/HOA mentions (Whitney Ranch, Empire Ranch, Laguna, Hidden Lakes, etc.) |
| P8 | Hub 301s satellite `/fencing/{city}/` to city domains | `twinrivers/netlify.toml` |

---

## Site-by-site assessment

### 1. rocklinfencing.com

| Area | Status | Notes |
|---|---|---|
| Framework | Static generator (inferred; repo 404) | Matches Granite Bay scaffold |
| Metadata | Good | Title/H1 aligned to “Rocklin Fence Company”; meta description present |
| Indexability | Appears crawlable | Lighthouse `is-crawlable` pass; pages appear in branded SERPs |
| Schema | Partial | Geo + cities OK; missing street/postal |
| Services IA | Solid | services, fence-types, gates, calculators, resources, service-areas |
| Conversion | Present | `tel:` CTAs + forms → `/.netlify/functions/contact-lead` |
| Analytics | Missing | Critical |
| TTFB (curl) | ~0.24s | Healthy edge response |

**Priority fixes:** GA4; NAP completeness; ensure Rocklin GBP reviews point here; reduce overlap with hub Rocklin service URLs.

### 2. rosevillefencingca.com

| Area | Status | Notes |
|---|---|---|
| Domain choice | Awkward TLD brand | `rosevillefencingca.com` vs competitors on cleaner names |
| Sitemap | 81 URLs | Largest resource count among Placer satellites |
| SERP signal | Strong relative | Appeared #2 in tool SERP for “fence company Roseville” / “fence contractor Roseville CA” (see rankings report) |
| Same shared limitations | Analytics, NAP, multi-domain policy risk | |

### 3. folsomfencing.com

| Area | Status | Notes |
|---|---|---|
| SERP signal | Strongest city home in sample | #1 organic in tool SERP for “fence company Folsom” and “fencing contractors Folsom” |
| Content | Local corridor framing | Empire Ranch / Folsom Ranch / American River |
| Risk | Competitor density high | Fantastic Fence, Stronghold, Folsom Fence Company, GreenTech |

### 4. elkgrovefencing.com

| Area | Status | Notes |
|---|---|---|
| Positioning | Commercial / school / temp fencing | Differentiated vs pure residential clones |
| SERP signal | Present but lower | ~#5 for “fence company Elk Grove” behind Fantastic Fence, Build Rite, elkgrovefencecompany.com |
| Opportunity | Lean into commercial + temp + EGUSD campus work with case studies | |

### 5. grassvalleyfencing.com

| Area | Status | Notes |
|---|---|---|
| Largest city sitemap | 102 URLs | 18 service-area pages — deepest local IA |
| HQ city | Matches business address on BuildZoom | Best natural local fit |
| SERP signal for head term | Weak in sample | “fence company Grass Valley” top results dominated by D-Fence, Sta-Bull, Nevada County Fence, Gold Country — Twin Rivers home **not** in top 5 tool results |
| Long-tail | Better | `grassvalleyfencing.com/wood-fencing/` appeared for “wood fence Grass Valley CA” |

### 6. granitebayfencing.com (bonus; live + source present)

| Area | Status | Notes |
|---|---|---|
| Source | `/tmp` clone of `Lordsleezy/granitebay-site` | Full generator audit possible |
| Quality | Strongest documented city implementation | Unique estate/HOA copy; calculators; reviews function |
| Issue | Sibling service-areas noindexed but still maintained | Prefer redirects to dedicated city domains |
| SEO report file mislabeled | Repo contains Roseville-titled performance report | Cleanup hygiene |

### 7. twinriversfence.com (hub)

| Area | Status | Notes |
|---|---|---|
| Role | Brand + multi-city coverage + lead ledger | Correct parent |
| Scale risk | 180 sitemap URLs; 104 services | Many programmatic city×service pages |
| Generators | `scripts/generate-unique-city-pages.mjs`, `seo-city-data.mjs`, templates | Seeded uniqueness — better than thin clones, still scaled |
| Leads | `lead-ingest` + admin | UTM fields supported in normalizer |
| Analytics | Missing | Same as cities |

---

## Duplicate content & doorway evaluation

**Similarity:** Homepage paragraph token Jaccard between city pairs ranges ~0.36–0.61 (highest Folsom↔Grass Valley 0.61, Roseville↔Grass Valley 0.56). Not identical clones, but shared scaffold is obvious.

**Policy lens (Google doorway abuse):** Multiple domains with slight variations maximizing reach for city queries, funneling to one contractor, is explicitly called out. Mitigations already present: unique local paragraphs, parent disclosure, some noindex on overlaps, hub→city 301s for `/fencing/{city}/`. Residual risk remains from (a) hub still indexing satellite-city service URLs, (b) seven near-parallel sites, (c) identical phone/Maps entity signals.

**Architecture recommendation (SEO strategy, not legal advice):**

1. **Short term:** Keep current domains; stop buying more; fix analytics + hub overlap.  
2. **Medium term (preferred if GSC shows weak multi-domain ROI):** Consolidate ranking equity into `twinriversfence.com` city hubs + 1–2 strongest satellites (e.g. Folsom + Grass Valley HQ).  
3. **Do not:** Mass-generate more AI city domains or fake storefronts.

---

## Conversion & tracking audit

| Capability | Present? | Notes |
|---|---|---|
| Click-to-call | Yes | Consistent number |
| Quote forms / chat (“River”) | Yes | Netlify functions + Turnstile env pattern |
| Lead attribution by domain | Code supports | `source_domain` allowlist in `lead-ingest` |
| GA4 / GTM | **No** | Blind to organic→lead |
| Call tracking | **No** | |
| CRM sync | Unknown | Not evidenced in public HTML |
| Admin lead UI | Hub `/admin/leads` | Documented in twinrivers README |

---

## Core Web Vitals (lab only — not CrUX)

| Site | Perf | SEO | LCP | CLS | TBT | Method |
|---|---|---|---|---|---|---|
| rocklinfencing.com | 80 | 100 | 3.6s | 0 | 280ms | Lighthouse mobile, Chromium headless, 2026-10-21 |
| folsomfencing.com | 86 | 100 | 3.5s | 0.001 | 200ms | same |
| grassvalleyfencing.com | 85 | 100 | 3.5s | 0 | 220ms | same |
| twinriversfence.com | 87 | 100 | 3.7s | 0.001 | 60ms | same |

PageSpeed Insights API quota exceeded in this environment; field CrUX not retrieved.

---

## Differences between city websites

| Dimension | Pattern |
|---|---|
| Shared | Phone, license, Maps link, generator IA (services/types/gates/decks/patios/calculators), lead function, Netlify hosting |
| Differentiated | `localName`, geo coords, areaServed cities, neighborhood copy, Elk Grove commercial tilt, Grass Valley foothill/ag pages, Folsom corridor pages |
| Size | Grass Valley deepest (102); Rocklin leanest (62) |
| Domain branding | Roseville uses `…fencingca.com`; others `…fencing.com` |

---

## Evidence appendix

- Live fetches: HTTP 200 all domains 2026-10-21  
- Config domains: `twinrivers/src/data/site.mjs` `dedicatedCitySites`  
- Prior network doc: `twinrivers/TWIN-RIVERS-NETWORK-SEO-IMPLEMENTATION.md` (2026-07-21)  
- Lead allowlist: `twinrivers/netlify/functions/lead-ingest.mjs`  
- Granite Bay site config: `granitebay-site/src/data/site.js`
