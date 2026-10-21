import { site } from "../data/site.js";
import { escapeHtml, faqSchema, renderLayout, riverContactSection } from "./layout.js";

const homeFaqs = [
  {
    "question": "Do you build decks in Sacramento?",
    "answer": "Yes. Twin Rivers Fence builds and repairs wood, composite, and redwood decks in the Sacramento region. Call (916) 906-2254 for a free estimate."
  },
  {
    "question": "Are you a licensed contractor?",
    "answer": "Yes. Work is performed under California contractor license #1089233."
  },
  {
    "question": "Do you also install fencing?",
    "answer": "Yes. Twin Rivers Fence is primarily a fencing contractor and also builds decks and related outdoor structures. Fence projects can be quoted separately or coordinated with a deck build."
  },
  {
    "question": "Do calculators on this site provide final pricing?",
    "answer": "No. Online tools are educational only. Binding pricing requires a site-specific quote after we see grade, access, and attachment conditions."
  }
];

export function renderHomePage() {
  const body = `
  <section id="hero">
    <canvas id="hero-canvas" aria-hidden="true"></canvas>
    <div class="hero-inner">
      <p class="eyebrow">Sacramento region · Licensed #1089233</p>
      <h1>Sacramento Deck Building</h1>
      <p class="sub">Wood, composite, and redwood decks — free estimates. Call (916) 906-2254. Built by Twin Rivers Fence for Sacramento Valley homes.</p>
      <p class="sub" style="margin-top:0.5rem">Hours: ${escapeHtml(site.hours)}</p>
      <a href="#contact" class="btn-gold">Get a Free Estimate</a>
      <a href="tel:${site.phoneTel}" class="btn-gold" style="margin-left:0.75rem;background:transparent;border:1px solid rgba(255,255,255,0.45)">Call ${escapeHtml(site.phoneDisplay)}</a>
      <div class="google-trust-bar" aria-label="Twin Rivers Fence trust signals">
        <a class="google-review-link" href="${site.googleReviewsUrl}" target="_blank" rel="noopener noreferrer"><span class="google-star-row" aria-label="Reviews on Google">Google reviews</span> — Twin Rivers Fence</a>
        <span>Licensed &amp; Insured — #${site.license}</span>
        <span>${escapeHtml(site.hours)}</span>
      </div>
    </div>
    <div class="scroll-cue" aria-hidden="true"><span>Scroll</span><div class="scroll-line"></div></div>
  </section>

  
  <section class="photo-section" id="wood-deck">
    <img class="photo-bg" src="https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1600&q=80" alt="Wood deck with outdoor seating" width="1600" height="900" loading="eager" decoding="async" fetchpriority="high">
    <div class="photo-content left"><span class="section-tag">Wood Decks Sacramento</span><h2>Outdoor rooms<br>worth using.</h2><p>Raised and ground-level wood decks planned around grade, access, and how you entertain — not a one-size kit.</p></div>
  </section>

  <section class="photo-section overlay-right" id="composite">
    <img class="photo-bg" src="https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1600&q=80" alt="Modern outdoor deck living space" width="1600" height="900" loading="lazy" decoding="async">
    <div class="photo-content right"><span class="section-tag">Composite Decks</span><h2>Less upkeep.<br>More weekends.</h2><p>Composite decking options for homeowners who want outdoor living space without annual staining cycles.</p></div>
  </section>

  <section class="dark-section who">
    <div class="who-grid">
      <div class="who-copy">
        <h2>Decks planned for how Sacramento yards are actually used.</h2>
        <p>Twin Rivers Fence builds and repairs decks across the Sacramento region under California contractor license #1089233.</p><p>We focus on structure first: footings, ledger connections, guardrails, and fasteners sized for valley heat and occasional winter rain — then finish with the board surface and railing style you want.</p>
        <p>Services on this site are provided by <a href="https://twinriversfence.com/">Twin Rivers Fence</a>.</p>
        <p class="license">Licensed Contractor #${site.license} — ${escapeHtml(site.address.locality)}, CA</p>
      </div>
      <div class="stats" aria-label="Trust signals">
        <div class="stat-card"><div class="stat-number">✓</div><div class="stat-label">Licensed #${site.license}</div></div>
        <div class="stat-card"><div class="stat-number">✓</div><div class="stat-label">Insured</div></div>
        <div class="stat-card"><div class="stat-number">G</div><div class="stat-label"><a href="${site.googleReviewsUrl}" target="_blank" rel="noopener noreferrer">Google Business Profile</a></div></div>
      </div>
    </div>
  </section>

  <section class="dark-section services">
  <h2 class="section-heading">Services</h2>
  <div class="services-grid">
    <article class="service-card"><h3><a href="/decks/wood-deck/">Wood Decks</a></h3><p>Cedar and pressure-treated systems built for Sacramento Valley conditions.</p></article>
    <article class="service-card"><h3><a href="/decks/composite-deck/">Composite Decks</a></h3><p>Low-maintenance boards with solid framing underneath.</p></article>
    <article class="service-card"><h3><a href="/decks/redwood-deck/">Redwood Decks</a></h3><p>Classic redwood surfaces with modern fastening details.</p></article>
    <article class="service-card"><h3><a href="/decks/deck-railing/">Deck Railing</a></h3><p>Code-minded guardrails that match the deck and house.</p></article>
    <article class="service-card"><h3><a href="/decks/pergola/">Pergolas</a></h3><p>Shade structures that pair with new or existing decks.</p></article>
    <article class="service-card"><h3><a href="/decks/deck-repair/">Deck Repair</a></h3><p>Board replacement, railing fixes, and structural repairs.</p></article>
    <article class="service-card"><h3><a href="/services/deck-installation/">Deck Installation</a></h3><p>Full new builds from footing layout to finish.</p></article>
    <article class="service-card"><h3><a href="/resources/deck-cost-guide/">Deck Cost Guide</a></h3><p>How Sacramento deck pricing usually breaks down.</p></article>
  </div>
  </section>

  

  <section class="dark-section alt areas">
    <h2>Areas we serve</h2>
    <p class="sub-text">Local focus — not generic filler</p>
    <div class="tag-cloud" aria-label="Service areas">
    <span class="city-tag">Land Park</span>
    <span class="city-tag">East Sacramento</span>
    <span class="city-tag">Natomas</span>
    <span class="city-tag">Carmichael</span>
    <span class="city-tag">Fair Oaks</span>
    <span class="city-tag">Citrus Heights</span>
    <span class="city-tag">West Sacramento</span>
    </div>
  </section>

  <section class="dark-section alt faq-section" id="home-faq">
    <h2 class="section-heading">Frequently asked questions</h2>
    <div class="faq-list">
      ${homeFaqs
        .map(
          (f) => `
      <details class="faq-item">
        <summary>${escapeHtml(f.question)}</summary>
        <p>${escapeHtml(f.answer)}</p>
      </details>`
        )
        .join("")}
    </div>
  </section>

  ${riverContactSection({
    heading: "Get a free estimate",
    note: "Tell us about your project — we will give you a straight answer. Or call " + site.phoneDisplay + ".",
  })}
`;

  return renderLayout({
    title: "Sacramento Deck Builders | Free Estimates | License #1089233",
    description: "Sacramento deck building and repair — wood, composite, and redwood decks with railings and pergolas. Twin Rivers Fence — licensed #1089233.",
    path: "/",
    body,
    schemaExtra: [faqSchema(homeFaqs)],
  });
}
