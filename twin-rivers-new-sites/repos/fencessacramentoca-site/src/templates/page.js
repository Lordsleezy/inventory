import { site } from "../data/site.js";
import {
  escapeHtml,
  buildCrumbs,
  renderBreadcrumbs,
  breadcrumbSchema,
  faqSchema,
  serviceSchema,
  renderLayout,
  leadHoneypotField,
  turnstileWidget,
  riverContactSection,
} from "./layout.js";

function paragraphs(list = []) {
  return list.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
}

function bullets(list) {
  if (!list?.length) return "";
  return `<ul>${list.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`;
}

function relatedBlock(related = []) {
  if (!related.length) return "";
  return `
<section class="dark-section related-section">
  <h2 class="section-heading">Related guides &amp; services</h2>
  <div class="internal-links">
    ${related.map((r) => `<a href="${r.href}">${escapeHtml(r.label)}</a>`).join("")}
  </div>
</section>`;
}

function faqBlock(faqs = []) {
  if (!faqs.length) return "";
  return `
<section class="dark-section alt faq-section" id="faq">
  <h2 class="section-heading">Frequently asked questions</h2>
  <div class="faq-list">
    ${faqs
      .map(
        (f) => `
    <details class="faq-item">
      <summary>${escapeHtml(f.question)}</summary>
      <p>${escapeHtml(f.answer)}</p>
    </details>`
      )
      .join("")}
  </div>
</section>`;
}

function trustStrip() {
  return `
<section class="trust-strip" aria-label="Trust signals">
  <div class="trust-strip-inner">
    <span>Licensed #${site.license}</span>
    <span>Insured</span>
    <span>${site.yearsExperience}+ Years Experience</span>
    <span>${escapeHtml(site.trustLocality || "Northern California")}</span>
    <a href="${site.googleReviewsUrl}" target="_blank" rel="noopener noreferrer">Google Business Profile</a>
  </div>
</section>`;
}

function contactSection(note) {
  return riverContactSection({
    heading: "Get a free estimate",
    note: note || ("Tell us about your project in " + site.address.locality + " — we will give you a straight answer and a real quote."),
  });
}

function pageHero(page, crumbs) {
  return `
<section class="page-hero">
  ${renderBreadcrumbs(crumbs)}
  <p class="eyebrow">${escapeHtml(page.eyebrow || "Twin Rivers Fence")}</p>
  <h1>${escapeHtml(page.h1)}</h1>
  <p class="sub">${escapeHtml(page.intro)}</p>
  <div class="hero-cta-row">
    <a href="#contact" class="btn-gold">Get a Free Estimate</a>
    <a href="tel:${site.phoneTel}" class="btn-ghost">Call ${site.phoneDisplay}</a>
  </div>
</section>
${trustStrip()}`;
}

function contentSections(sections = []) {
  return sections
    .map(
      (s) => `
<section class="dark-section content-block">
  <div class="prose">
    <h2>${escapeHtml(s.heading)}</h2>
    ${paragraphs(s.paragraphs)}
    ${bullets(s.bullets)}
  </div>
</section>`
    )
    .join("");
}

function googleReviewsSection() {
  return `
<section class="dark-section alt google-reviews-section" data-google-reviews-section>
  <div class="google-review-intro">
    <span class="section-tag">Google Reviews</span>
    <h2>Trusted across Northern California</h2>
    <p class="sub-text">A verified Google Business Profile with real customer feedback.</p>
    <p class="google-review-status" data-google-reviews-status>Loading verified Google profile...</p>
  </div>
  <div class="google-review-cards" data-google-review-cards>
    <article class="google-review-card"><p>Loading verified Google profile...</p></article>
  </div>
  <div class="google-review-actions">
    <a class="btn-gold google-review-link" href="${site.googleReviewsUrl}" target="_blank" rel="noopener noreferrer">Read Reviews On Google</a>
  </div>
</section>`;
}


function citySlug(locality = "") {
  return String(locality).toLowerCase().replace(/\s+/g, "-");
}

function renderFenceQuote() {
  const selected = citySlug(site.address.locality);
  const options = [
    ["sacramento", "Sacramento"],
    ["elk-grove", "Elk Grove"],
    ["folsom", "Folsom"],
    ["rocklin", "Rocklin"],
    ["roseville", "Roseville"],
    ["granite-bay", "Granite Bay"],
    ["grass-valley", "Grass Valley"],
    ["other", "Other"],
  ]
    .map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`)
    .join("");
  return `
<section class="dark-section quote-calculator-section" id="fence-quote">
  <div class="quote-calculator-shell">
    <div class="quote-calculator-header">
      <span class="section-tag">Fence Quote</span>
      <h2>Get a preliminary online estimate in under 30 seconds.</h2>
      <p class="sub-text">Use this calculator for a budgetary planning range only. Send your details and Twin Rivers Fence will follow up with an exact on-site quote for ${escapeHtml(site.address.locality)}.</p>
    </div>
    <div class="quote-calculator-grid" data-quote-calculator>
      <form class="quote-form-card" data-quote-inputs>
        <div class="quote-field-grid">
          <div class="quote-field">
            <label for="quote-fence-type">Fence Type</label>
            <select id="quote-fence-type" name="fence_type">
              <option value="wood">Wood Privacy Fence</option>
              <option value="cedar">Cedar Fence</option>
              <option value="vinyl">Vinyl Fence</option>
              <option value="chainlink">Chain Link Fence</option>
              <option value="ornamental">Ornamental Iron Fence</option>
              <option value="ranch">Ranch Fence</option>
              <option value="custom">Custom Fence</option>
            </select>
          </div>
          <div class="quote-field">
            <label for="quote-height">Fence Height</label>
            <select id="quote-height" name="height">
              <option value="4">4 Foot</option>
              <option value="6" selected>6 Foot</option>
              <option value="8">8 Foot</option>
            </select>
          </div>
          <div class="quote-field">
            <label for="quote-footage">Linear Footage</label>
            <input id="quote-footage" name="footage" type="number" min="10" step="1" value="100" inputmode="numeric">
          </div>
          <div class="quote-field">
            <label for="quote-gates">Number of Gates</label>
            <select id="quote-gates" name="gates">
              <option value="0">0</option>
              <option value="1" selected>1</option>
              <option value="2">2</option>
              <option value="3">3+</option>
            </select>
          </div>
          <div class="quote-field">
            <label for="quote-removal">Existing Fence Removal</label>
            <select id="quote-removal" name="removal">
              <option value="no" selected>No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          <div class="quote-field full">
            <label for="quote-city">City</label>
            <select id="quote-city" name="city">${options}</select>
          </div>
        </div>
      </form>
      <aside class="quote-result-card">
        <span class="estimate-range-label">Preliminary Online Estimate</span>
        <div class="estimate-range" data-estimate-range>$0 - $0</div>
        <p class="estimate-note"><strong>This is a preliminary online estimate for budget planning only.</strong> It is not a final quote. On-site pricing depends on access, grade, material availability, gates, removals, and site conditions.</p>
        <div class="offer-card-grid" aria-label="Twin Rivers Fence estimate offers">
          <div class="offer-card"><strong>Schedule Today</strong><span>Receive up to 15% off qualifying projects.</span></div>
          <div class="offer-card"><strong>Refer A Friend</strong><span>Receive up to 25% off for both you and your referred friend.</span></div>
        </div>
        <form name="instant-quote" method="POST" action="/.netlify/functions/contact-lead" netlify-honeypot="bot-field" class="quote-lead-form" data-quote-lead-form>
          <input type="hidden" name="form-name" value="instant-quote">
          <input type="hidden" name="lead_type" value="fence-quote">
          <input type="hidden" name="source" value="${escapeHtml(site.domain.replace(/^https?:\/\//, ""))}">
          ${leadHoneypotField()}
          <input type="hidden" name="estimated_range">
          <input type="hidden" name="fence_type">
          <input type="hidden" name="height">
          <input type="hidden" name="footage">
          <input type="hidden" name="gates">
          <input type="hidden" name="removal">
          <input type="hidden" name="city">
          <input type="hidden" name="lead_id">
          <div class="quote-field"><label for="quote-name">Name</label><input id="quote-name" name="name" type="text" autocomplete="name"></div>
          <div class="quote-field"><label for="quote-phone">Phone Number (Required)</label><input id="quote-phone" name="phone" type="tel" autocomplete="tel" required></div>
          <div class="quote-field"><label for="quote-email">Email (Optional)</label><input id="quote-email" name="email" type="email" autocomplete="email"></div>
          <div class="quote-field"><label for="quote-notes">Project Notes</label><textarea id="quote-notes" name="notes"></textarea></div>
          ${turnstileWidget()}
          <button class="btn-gold" type="submit">Get My Exact Quote</button>
          <p class="quote-status" data-quote-status aria-live="polite"></p>
        </form>
      </aside>
    </div>
  </div>
</section>`;
}

function toolCards(cards = []) {
  if (!cards.length) return "";
  return `
<section class="dark-section alt">
  <h2 class="section-heading">Planning tools</h2>
  <div class="hub-grid">
    ${cards
      .map(
        (item) => `
    <article class="hub-card">
      <h3><a href="${item.href}">${escapeHtml(item.label)}</a></h3>
      <p>${escapeHtml(item.blurb)}</p>
    </article>`
      )
      .join("")}
  </div>
</section>`;
}

export function renderContentPage(page, options = {}) {
  const crumbs = buildCrumbs(page);
  const isQuoteTool = options.calculatorId === "fence-quote";
  const calculatorMarkup = isQuoteTool
    ? renderFenceQuote()
    : options.calculatorId
    ? `<section class="dark-section alt calculator-section"><div class="calculator-shell" data-calculator="${options.calculatorId}"></div></section>`
    : "";

  const howItWorks =
    options.howItWorks?.length
      ? `<section class="dark-section content-block"><div class="prose"><h2>How this tool works</h2><ol class="step-list">${options.howItWorks.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol></div></section>`
      : "";

  const assumptions =
    options.assumptions?.length
      ? `<section class="dark-section alt content-block"><div class="prose"><h2>Assumptions &amp; notes</h2>${bullets(options.assumptions)}</div></section>`
      : "";

  const seoPage = page.type === "location" ? { ...page, title: page.title.replace(/ Fence (Company|Contractor)/g, " Fence Service Area"), h1: page.h1.replace(/ Fence (Company|Contractor)/g, " Fence Service Area") } : page;

  const body = `
${pageHero(seoPage, crumbs)}
${contentSections(page.sections)}
${toolCards(page.toolCards)}
${howItWorks}
${calculatorMarkup}
${assumptions}
${faqBlock(page.faqs)}
${relatedBlock(page.related)}
${googleReviewsSection()}
${contactSection(page.ctaNote)}
`;

  const schemas = [
    breadcrumbSchema(crumbs),
    faqSchema(page.faqs),
    ["service", "fence-type", "gate", "county"].includes(page.type) ? serviceSchema(page) : null,
  ];

  return renderLayout({
    title: seoPage.title,
    description: page.description,
    path: page.path,
    body,
    schemas,
    includeCalculators: Boolean(options.calculatorId) && options.calculatorId !== "fence-quote",
    includeQuoteTool: isQuoteTool,
    noindex: Boolean(page.noindex),
  });
}

export function renderHubCards(items, heading) {
  return `
<section class="dark-section">
  <h2 class="section-heading">${escapeHtml(heading)}</h2>
  <div class="hub-grid">
    ${items
      .map(
        (item) => `
    <article class="hub-card">
      <h3><a href="${item.path}">${escapeHtml(item.h1)}</a></h3>
      <p>${escapeHtml(item.description)}</p>
    </article>`
      )
      .join("")}
  </div>
</section>`;
}
