import { site } from "../data/site.js";
import { escapeHtml, faqSchema, renderLayout, riverContactSection } from "./layout.js";

const homeFaqs = [
  {
    "question": "Do you install fences in Citrus Heights?",
    "answer": "Yes. Twin Rivers Fence serves Citrus Heights with installation, repair, wood, vinyl, chain link, and gates. Call (916) 906-2254."
  },
  {
    "question": "What nearby cities do you also serve?",
    "answer": "From Citrus Heights we commonly take projects in Orangevale, Fair Oaks, Antelope, and Carmichael when scheduling fits. Dedicated Twin Rivers sites also cover Roseville, Rocklin, Folsom, and Elk Grove."
  },
  {
    "question": "Are you licensed and insured?",
    "answer": "Yes. California contractor license #1089233 with insurance for residential and commercial fence work."
  },
  {
    "question": "Is citrusheightsfencing.com part of Twin Rivers Fence?",
    "answer": "Yes. This is Twin Rivers Fence’s Citrus Heights site — same crew and phone number."
  }
];

export function renderHomePage() {
  const body = `
  <section id="hero">
    <canvas id="hero-canvas" aria-hidden="true"></canvas>
    <div class="hero-inner">
      <p class="eyebrow">Citrus Heights, California · Licensed #1089233</p>
      <h1>Citrus Heights Fence Company</h1>
      <p class="sub">Citrus Heights Fence Company — free estimates. Call (916) 906-2254 for wood, vinyl, repairs, and gates along Sunrise, Greenback, and nearby neighborhoods.</p>
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

  
  <section class="photo-section" id="privacy">
    <img class="photo-bg" src="https://images.unsplash.com/photo-1604015641586-6fa03629f976?auto=format&fit=crop&w=1600&q=80" alt="Residential privacy fence" width="1600" height="900" loading="eager" decoding="async" fetchpriority="high">
    <div class="photo-content left"><span class="section-tag">Privacy Fence Citrus Heights</span><h2>Backyard privacy<br>done cleanly.</h2><p>Board-on-board and standard privacy lines for Citrus Heights homes that need a finished look from both sides.</p></div>
  </section>

  <section class="photo-section overlay-right" id="repair">
    <img class="photo-bg" src="https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1600&q=80" alt="Fence hardware and repair work" width="1600" height="900" loading="lazy" decoding="async">
    <div class="photo-content right"><span class="section-tag">Fence Repair</span><h2>Fix the lean.<br>Keep the line.</h2><p>Post replacement, panel repair, and gate rebuilds when a full tear-out is not required.</p></div>
  </section>

  <section class="dark-section who">
    <div class="who-grid">
      <div class="who-copy">
        <h2>Local fencing for Citrus Heights yards and side streets.</h2>
        <p>Twin Rivers Fence is a licensed contractor (#1089233) serving Citrus Heights with fence installation, repair, vinyl and wood privacy lines, and gates.</p><p>Older neighborhoods near Arcade Creek and established tracts along Greenback Boulevard often need post work in mixed soils plus gates that still clear uneven concrete paths. We quote from the property — not a generic package.</p>
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
    <article class="service-card"><h3><a href="/services/fence-installation/">Fence Installation</a></h3><p>New residential fence lines sized for Citrus Heights lots.</p></article>
    <article class="service-card"><h3><a href="/fence-repair/">Fence Repair</a></h3><p>Posts, panels, and gates repaired without unnecessary full replacement.</p></article>
    <article class="service-card"><h3><a href="/wood-fencing/">Wood Fencing</a></h3><p>Cedar and redwood privacy for valley sun exposure.</p></article>
    <article class="service-card"><h3><a href="/vinyl-fencing/">Vinyl Fencing</a></h3><p>Low-maintenance privacy and pool-adjacent runs.</p></article>
    <article class="service-card"><h3><a href="/custom-gates/">Gates</a></h3><p>Side-yard and driveway gates built for daily use.</p></article>
    <article class="service-card"><h3><a href="/chain-link-fencing/">Chain Link</a></h3><p>Practical boundaries and dog runs.</p></article>
    <article class="service-card"><h3><a href="/commercial-fencing/">Commercial</a></h3><p>Light commercial and multifamily perimeter work.</p></article>
    <article class="service-card"><h3><a href="/fence-types/pool-fence/">Pool Fencing</a></h3><p>Code-minded pool barriers with self-latching gates.</p></article>
  </div>
  </section>

  

  <section class="dark-section alt areas">
    <h2>Areas we serve</h2>
    <p class="sub-text">Local focus — not generic filler</p>
    <div class="tag-cloud" aria-label="Service areas">
    <span class="city-tag">Sunrise Blvd corridor</span>
    <span class="city-tag">Greenback Blvd</span>
    <span class="city-tag">Arcade Creek area</span>
    <span class="city-tag">Sayonara Drive area</span>
    <span class="city-tag">Orangevale edge</span>
    <span class="city-tag">Antelope edge</span>
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
    title: "Citrus Heights Fence Company | Free Estimates | License #1089233",
    description: "Citrus Heights fence company for wood, vinyl, repair, and gates. Twin Rivers Fence — licensed #1089233.",
    path: "/",
    body,
    schemaExtra: [faqSchema(homeFaqs)],
  });
}
