import { site } from "../data/site.js";
import { escapeHtml, faqSchema, renderLayout, riverContactSection } from "./layout.js";

const homeFaqs = [
  {
    "question": "Do you fence properties inside the City of Sacramento?",
    "answer": "Yes. Twin Rivers Fence handles residential, multifamily, and commercial fencing in Sacramento. Call (916) 906-2254."
  },
  {
    "question": "How is this different from your Roseville or Folsom sites?",
    "answer": "Those sites focus on their cities. fencessacramentoca.com focuses on Sacramento city neighborhoods and commercial/multifamily work, and points Placer or Elk Grove homeowners to the matching Twin Rivers city site."
  },
  {
    "question": "Are you licensed?",
    "answer": "Yes. California contractor license #1089233."
  },
  {
    "question": "Do you invent project counts or review scores on this site?",
    "answer": "No. We stick to verified facts: license, phone, hours, and our Google Business Profile link. Ask us for references from recent local work."
  }
];

export function renderHomePage() {
  const body = `
  <section id="hero">
    <canvas id="hero-canvas" aria-hidden="true"></canvas>
    <div class="hero-inner">
      <p class="eyebrow">City of Sacramento · Licensed #1089233</p>
      <h1>Sacramento Fence Company</h1>
      <p class="sub">Fencing for Sacramento city neighborhoods, multifamily, and commercial sites. Free estimates — call (916) 906-2254. Twin Rivers Fence.</p>
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

  
  <section class="photo-section" id="residential">
    <img class="photo-bg" src="https://images.unsplash.com/photo-1604015641586-6fa03629f976?auto=format&fit=crop&w=1600&q=80" alt="Residential wood fence" width="1600" height="900" loading="eager" decoding="async" fetchpriority="high">
    <div class="photo-content left"><span class="section-tag">Sacramento Residential</span><h2>Neighborhood fencing<br>with clear scopes.</h2><p>Privacy and repair work for Land Park, East Sac, Pocket, Natomas, and Midtown-adjacent lots — quoted from the actual line.</p></div>
  </section>

  <section class="photo-section overlay-right" id="commercial">
    <img class="photo-bg" src="https://images.unsplash.com/photo-1503387762-592deb58ef4e?auto=format&fit=crop&w=1600&q=80" alt="Commercial construction site perimeter" width="1600" height="900" loading="lazy" decoding="async">
    <div class="photo-content right"><span class="section-tag">Commercial & Multifamily</span><h2>Perimeters that<br>protect the schedule.</h2><p>Security chain link, ornamental frontage, temporary jobsite panels, and multifamily edge fencing with clear communication.</p></div>
  </section>

  <section class="dark-section who">
    <div class="who-grid">
      <div class="who-copy">
        <h2>One licensed contractor — city work and commercial scopes.</h2>
        <p>Twin Rivers Fence serves Sacramento under California contractor license #1089233. This site focuses on City of Sacramento residential neighborhoods and commercial or multifamily fencing — not thin copies of our Placer or Elk Grove city sites.</p><p>Need Roseville, Rocklin, Folsom, Elk Grove, Grass Valley, or Granite Bay specifically? Use those Twin Rivers city sites for local pages. Need Sacramento city or commercial help? Start here or call (916) 906-2254.</p>
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
    <article class="service-card"><h3><a href="/services/residential-fencing/">Residential Fencing</a></h3><p>City-lot privacy, repair, and replacement.</p></article>
    <article class="service-card"><h3><a href="/commercial-fencing/">Commercial Fencing</a></h3><p>Business parcels, yards, and security perimeters.</p></article>
    <article class="service-card"><h3><a href="/services/multifamily-fencing/">Multifamily Fencing</a></h3><p>Apartment and HOA-community consistent lines.</p></article>
    <article class="service-card"><h3><a href="/temporary-fence-rental/">Temporary Fence</a></h3><p>Construction and event panels.</p></article>
    <article class="service-card"><h3><a href="/fence-repair/">Fence Repair</a></h3><p>Fast assessment when a full rebuild is not needed.</p></article>
    <article class="service-card"><h3><a href="/custom-gates/">Gates</a></h3><p>Walk and driveway gates for city and commercial sites.</p></article>
    <article class="service-card"><h3><a href="/wood-fencing/">Wood Fencing</a></h3><p>Cedar and redwood for Sacramento heat.</p></article>
    <article class="service-card"><h3><a href="/resources/sacramento-fence-permits/">Permit Guidance</a></h3><p>High-level City of Sacramento permit orientation.</p></article>
  </div>
  </section>

  
  <section class="dark-section alt hub-preview">
    <h2 class="section-heading">Need a different Twin Rivers city?</h2>
    <p class="sub-text">This site focuses on Sacramento city &amp; commercial work. Use a dedicated city site when that market fits better.</p>
    <div class="hub-grid">
      <article class="hub-card"><h3><a href="https://rosevillefencingca.com/">Roseville</a></h3><p>Dedicated Roseville fencing site.</p></article>
      <article class="hub-card"><h3><a href="https://rocklinfencing.com/">Rocklin</a></h3><p>Dedicated Rocklin fencing site.</p></article>
      <article class="hub-card"><h3><a href="https://folsomfencing.com/">Folsom</a></h3><p>Dedicated Folsom fencing site.</p></article>
      <article class="hub-card"><h3><a href="/city-sites/">All city sites</a></h3><p>Full Twin Rivers city network directory.</p></article>
    </div>
  </section>

  <section class="dark-section alt areas">
    <h2>Areas we serve</h2>
    <p class="sub-text">Local focus — not generic filler</p>
    <div class="tag-cloud" aria-label="Service areas">
    <span class="city-tag">Natomas</span>
    <span class="city-tag">Land Park</span>
    <span class="city-tag">East Sacramento</span>
    <span class="city-tag">Midtown / grid edge</span>
    <span class="city-tag">Pocket / Greenhaven</span>
    <span class="city-tag">South Sacramento</span>
    <span class="city-tag">Arden-Arcade edge</span>
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
    title: "Sacramento Fence Company | Free Estimates | License #1089233",
    description: "Sacramento fence company for city neighborhoods, multifamily, and commercial fencing. Twin Rivers Fence — licensed #1089233. Sister city sites cover Roseville, Rocklin, Folsom, Elk Grove, and more.",
    path: "/",
    body,
    schemaExtra: [faqSchema(homeFaqs)],
  });
}
