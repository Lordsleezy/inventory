import { site } from "../data/site.js";
import { escapeHtml, faqSchema, renderLayout, riverContactSection } from "./layout.js";

const homeFaqs = [
  {
    "question": "Do you install fences in West Sacramento?",
    "answer": "Yes. Twin Rivers Fence serves West Sacramento with fence installation, repair, wood, vinyl, chain link, gates, and light commercial fencing. Call (916) 906-2254."
  },
  {
    "question": "Are you licensed in California?",
    "answer": "Yes. Twin Rivers Fence holds California contractor license #1089233 and carries insurance for residential and commercial fence work."
  },
  {
    "question": "What areas of West Sacramento do you cover?",
    "answer": "We work across Southport, Bridgeway Island, Broderick, Bryte, and nearby river-corridor properties. Call with your address to confirm scheduling."
  },
  {
    "question": "Is this the same company as Twin Rivers Fence?",
    "answer": "Yes. fencingwestsacramento.com is Twin Rivers Fence’s West Sacramento site — same license, same phone, focused on local West Sacramento projects."
  }
];

export function renderHomePage() {
  const body = `
  <section id="hero">
    <canvas id="hero-canvas" aria-hidden="true"></canvas>
    <div class="hero-inner">
      <p class="eyebrow">West Sacramento, California · Licensed #1089233</p>
      <h1>West Sacramento Fence Company</h1>
      <p class="sub">West Sacramento Fence Company — free estimates. Call (916) 906-2254 for wood, vinyl, chain link, repairs, and gates across Southport, Broderick, and the river corridor.</p>
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

  
  <section class="photo-section" id="wood">
    <img class="photo-bg" src="https://images.unsplash.com/photo-1604015641586-6fa03629f976?auto=format&fit=crop&w=1600&q=80" alt="Wood privacy fence along a residential property line" width="1600" height="900" loading="eager" decoding="async" fetchpriority="high">
    <div class="photo-content left"><span class="section-tag">Wood Fence West Sacramento</span><h2>Privacy that holds up<br>to valley heat.</h2><p>Cedar and redwood privacy lines sized for Southport backyards and older Broderick lots — with posts set for irrigated clay and summer sun.</p></div>
  </section>

  <section class="photo-section overlay-right" id="vinyl">
    <img class="photo-bg" src="https://images.unsplash.com/photo-1593285247650-cd7bb44adcfd?auto=format&fit=crop&w=1600&q=80" alt="Vinyl privacy fence on a residential lot" width="1600" height="900" loading="lazy" decoding="async">
    <div class="photo-content right"><span class="section-tag">Vinyl Fence West Sacramento</span><h2>Low maintenance.<br>Clean street face.</h2><p>Vinyl privacy and HOA-friendly panels for homeowners who want a durable line without annual staining.</p></div>
  </section>

  <section class="dark-section who">
    <div class="who-grid">
      <div class="who-copy">
        <h2>A licensed crew that knows West Sacramento lots.</h2>
        <p>Twin Rivers Fence is a California licensed contractor (#1089233) serving West Sacramento with fence installation, repair, gates, and light commercial fencing.</p><p>River-adjacent yards, newer Southport tract lots, and industrial parcels near the Port of West Sacramento each need different footing and material choices. We plan for irrigated clay, narrow side yards, and HOA design sheets before we quote.</p>
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
    <article class="service-card"><h3><a href="/services/fence-installation/">Fence Installation</a></h3><p>New fence lines for Southport tracts, river corridor lots, and light commercial edges.</p></article>
    <article class="service-card"><h3><a href="/fence-repair/">Fence Repair</a></h3><p>Leaning posts, storm damage, and gates that no longer latch cleanly.</p></article>
    <article class="service-card"><h3><a href="/custom-gates/">Custom Gates</a></h3><p>Side-yard walk gates and driveway gates sized for daily use.</p></article>
    <article class="service-card"><h3><a href="/wood-fencing/">Wood Fencing</a></h3><p>Cedar and redwood privacy built for Sacramento Valley heat.</p></article>
    <article class="service-card"><h3><a href="/vinyl-fencing/">Vinyl Fencing</a></h3><p>Low-maintenance privacy and pool-adjacent lines.</p></article>
    <article class="service-card"><h3><a href="/commercial-fencing/">Commercial Fencing</a></h3><p>Security and perimeter fencing for yards and business parcels.</p></article>
    <article class="service-card"><h3><a href="/chain-link-fencing/">Chain Link</a></h3><p>Practical security for rentals, dog runs, and long boundaries.</p></article>
    <article class="service-card"><h3><a href="/temporary-fence-rental/">Temporary Fence</a></h3><p>Jobsite panels for construction and short-term boundaries.</p></article>
  </div>
  </section>

  

  <section class="dark-section alt areas">
    <h2>Areas we serve</h2>
    <p class="sub-text">Local focus — not generic filler</p>
    <div class="tag-cloud" aria-label="Service areas">
    <span class="city-tag">Southport</span>
    <span class="city-tag">Bridgeway Island</span>
    <span class="city-tag">Broderick</span>
    <span class="city-tag">Bryte</span>
    <span class="city-tag">Riverfront</span>
    <span class="city-tag">Industrial Blvd corridor</span>
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
    title: "West Sacramento Fence Company | Free Estimates | License #1089233",
    description: "West Sacramento fence company for river-adjacent lots, Southport neighborhoods, and light commercial fencing. Twin Rivers Fence — licensed #1089233.",
    path: "/",
    body,
    schemaExtra: [faqSchema(homeFaqs)],
  });
}
