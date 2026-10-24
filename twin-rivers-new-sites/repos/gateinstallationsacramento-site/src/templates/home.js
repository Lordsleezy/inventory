import { site } from "../data/site.js";
import { escapeHtml, faqSchema, renderLayout, riverContactSection } from "./layout.js";

const homeFaqs = [
  {
    "question": "Do you install automatic driveway gates in Sacramento?",
    "answer": "Yes. Twin Rivers Fence installs and services automatic swing and slide gate operators with matching gate leaves. Call (916) 906-2254."
  },
  {
    "question": "Can you repair a sagging side-yard gate?",
    "answer": "Yes. We repair and rebuild walk gates and driveway gates, including posts, hinges, latches, and operators when needed."
  },
  {
    "question": "Are you licensed?",
    "answer": "Yes. California contractor license #1089233."
  },
  {
    "question": "Do you also build the fence connected to the gate?",
    "answer": "Yes. Twin Rivers Fence installs fencing and gates. Many projects include both; we can also replace only the gate when the fence line is sound."
  }
];

export function renderHomePage() {
  const body = `
  <section id="hero">
    <canvas id="hero-canvas" aria-hidden="true"></canvas>
    <div class="hero-inner">
      <p class="eyebrow">Sacramento region · Licensed #1089233</p>
      <h1>Sacramento Gate Installation</h1>
      <p class="sub">Driveway, automatic, wood, and iron gates — free estimates. Call (916) 906-2254. Installed by Twin Rivers Fence.</p>
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

  
  <section class="photo-section" id="driveway">
    <img class="photo-bg" src="https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&w=1600&q=80" alt="Residential driveway entrance with gate" width="1600" height="900" loading="eager" decoding="async" fetchpriority="high">
    <div class="photo-content left"><span class="section-tag">Driveway Gates</span><h2>Entries that work<br>every day.</h2><p>Swing and slide driveway gates planned for vehicle clearance, approach angle, and reliable latching.</p></div>
  </section>

  <section class="photo-section overlay-right" id="auto">
    <img class="photo-bg" src="https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1600&q=80" alt="Metal gate hardware detail" width="1600" height="900" loading="lazy" decoding="async">
    <div class="photo-content right"><span class="section-tag">Automatic Gates</span><h2>Operators, remotes,<br>and keypads.</h2><p>Automatic openers and access controls installed with posts and leaves built to handle the motion cycle.</p></div>
  </section>

  <section class="dark-section who">
    <div class="who-grid">
      <div class="who-copy">
        <h2>Gates engineered for daily use — not just curb appeal.</h2>
        <p>Twin Rivers Fence designs, installs, and repairs gates across the Sacramento region under California contractor license #1089233.</p><p>Gate posts see more stress than static fence panels. We size posts, hardware, and operators for swing arc, slide path, driveway grade, and how often the gate actually opens.</p>
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
    <article class="service-card"><h3><a href="/gates/driveway-gates/">Driveway Gates</a></h3><p>Single and dual-leaf entries sized for real vehicle traffic.</p></article>
    <article class="service-card"><h3><a href="/gates/automatic-gates/">Automatic Gates</a></h3><p>Operators, remotes, keypads, and opener service.</p></article>
    <article class="service-card"><h3><a href="/gates/wood-gates/">Wood Gates</a></h3><p>Side-yard and privacy gates matched to wood fence lines.</p></article>
    <article class="service-card"><h3><a href="/gates/iron-gates/">Iron Gates</a></h3><p>Ornamental and security iron for residential entries.</p></article>
    <article class="service-card"><h3><a href="/gates/gate-repair/">Gate Repair</a></h3><p>Sagging leaves, broken latches, and hardware upgrades.</p></article>
    <article class="service-card"><h3><a href="/custom-gates/">Custom Gates</a></h3><p>Fabrication for non-standard openings and mixed materials.</p></article>
    <article class="service-card"><h3><a href="/services/gate-installation/">Gate Installation</a></h3><p>New installs coordinated with fence lines or stand-alone.</p></article>
    <article class="service-card"><h3><a href="/resources/automatic-gate-guide/">Automatic Gate Guide</a></h3><p>What to plan before you buy an operator.</p></article>
  </div>
  </section>

  

  <section class="dark-section alt areas">
    <h2>Areas we serve</h2>
    <p class="sub-text">Local focus — not generic filler</p>
    <div class="tag-cloud" aria-label="Service areas">
    <span class="city-tag">Sacramento</span>
    <span class="city-tag">Natomas</span>
    <span class="city-tag">Roseville</span>
    <span class="city-tag">Rocklin</span>
    <span class="city-tag">Folsom</span>
    <span class="city-tag">Elk Grove</span>
    <span class="city-tag">Citrus Heights</span>
    <span class="city-tag">Granite Bay</span>
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
    title: "Sacramento Gate Installation | Free Estimates | License #1089233",
    description: "Sacramento gate installation and repair — driveway, automatic, wood, and iron gates. Twin Rivers Fence — licensed #1089233.",
    path: "/",
    body,
    schemaExtra: [faqSchema(homeFaqs)],
  });
}
