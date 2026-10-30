import { site, nav, fenceNavItems, gateNavItems, deckNavItems, patioNavItems, serviceNavItems, toolsNavItems, footerColumns, networkLinks } from "../data/site.js";

const assetVersion = "20260917-bot4";

const citySites = networkLinks;

const navMenus = {
  fencing: fenceNavItems,
  gates: gateNavItems,
  decks: deckNavItems,
  patios: patioNavItems,
  services: serviceNavItems,
  tools: toolsNavItems,
};

const dropdownActivePrefixes = {
  fencing: ["/fence-types/", "-fencing/"],
  gates: ["/gates/", "/custom-gates/"],
  decks: ["/decks/"],
  patios: ["/patios/"],
  services: ["/services/", "/fence-repair/", "/commercial-fencing/", "/temporary-fence-rental/"],
  tools: ["/calculators/"],
};

function isDropdownActive(dropdownKey, currentPath, itemHref, children) {
  const prefixes = dropdownActivePrefixes[dropdownKey] || [];
  if (prefixes.some((p) => (p.startsWith("-") ? currentPath.endsWith(p) : currentPath.startsWith(p)))) {
    return true;
  }
  if (currentPath === itemHref) return true;
  return children.some(
    (child) =>
      currentPath === child.href ||
      (child.href !== "/" && currentPath.startsWith(child.href))
  );
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function turnstileSiteKey() {
  return String(process.env.TURNSTILE_SITE_KEY || site.turnstileSiteKey || "").trim();
}

function leadHoneypotField() {
  return `<p class="quote-visually-hidden"><label>Don't fill this out: <input name="bot-field" tabindex="-1" autocomplete="off"></label></p>
<p class="quote-visually-hidden"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></p>`;
}

function turnstileWidget() {
  return `<div class="cf-turnstile" data-sitekey="${escapeHtml(turnstileSiteKey())}"></div>`;
}

function riverContactSection({ heading = "Contact Us", note = "" } = {}) {
  const city = escapeHtml(site.address.locality);
  const source = escapeHtml(String(site.domain || "").replace(/^https?:\/\//, ""));
  return `
<section class="dark-section" id="contact">
  <div class="ai-contact-header">
    <span class="section-tag">Free Estimate</span>
    <h2>${escapeHtml(heading)}</h2>
    ${note ? `<p>${escapeHtml(note)}</p>` : ""}
  </div>
  <div class="ai-contact-layout">
    <section class="river-chat" aria-label="Twin Rivers Fence project assistant chat">
      <div class="river-chat-top">
        <div class="river-status">
          <div class="river-avatar" aria-hidden="true">TR</div>
          <div>
            <strong>River</strong>
            <span>Twin Rivers estimate desk</span>
          </div>
        </div>
        <div class="river-live-dot" aria-label="Assistant is online"></div>
      </div>
      <div id="chat-log" class="chat-log" role="log" aria-live="polite" aria-relevant="additions"></div>
      <div class="quick-replies" aria-label="Suggested replies"></div>
      <div class="chat-composer">
        <label class="sr-only" for="chat-input">Message River</label>
        <input id="chat-input" type="text" autocomplete="off" placeholder="Tell River about your project...">
        <button class="chat-send" type="button">Send</button>
      </div>
      <p class="read-receipt" id="read-receipt" aria-live="polite"></p>
      <div class="lead-complete-note" aria-live="polite"></div>
    </section>
    <aside class="river-mascot-card" aria-label="River, a Twin Rivers Fence construction professional">
      <div class="speech-bubble">I'm ready when you are. The questions on the left help our crew price the right solution.</div>
      <div class="pro-worker" aria-hidden="true">
        <div class="pro-worker-shadow"></div>
        <div class="pro-hardhat"><span>TRF</span></div>
        <div class="pro-head">
          <div class="pro-brow left"></div>
          <div class="pro-brow right"></div>
          <div class="pro-eye left"></div>
          <div class="pro-eye right"></div>
          <div class="pro-nose"></div>
          <div class="pro-mouth"></div>
        </div>
        <div class="pro-neck"></div>
        <div class="pro-body">
          <div class="pro-collar left"></div>
          <div class="pro-collar right"></div>
          <div class="pro-logo">Twin Rivers</div>
        </div>
        <div class="pro-arm left"></div>
        <div class="pro-arm right"></div>
        <div class="pro-hand left"></div>
        <div class="pro-hand right"></div>
        <div class="pro-belt">
          <div class="pro-buckle"></div>
          <div class="pro-pouch left"></div>
          <div class="pro-pouch right"></div>
        </div>
        <div class="pro-leg left"></div>
        <div class="pro-leg right"></div>
        <div class="pro-boot left"></div>
        <div class="pro-boot right"></div>
      </div>
    </aside>
    <form name="contact" method="POST" action="/.netlify/functions/contact-lead" class="netlify-lead-form" aria-hidden="true">
      <input type="hidden" name="form-name" value="contact">
      <input type="hidden" name="city" value="${city}">
      <input type="hidden" name="source" value="${source}">
      <input type="hidden" name="name">
      <input type="hidden" name="phone">
      <input type="hidden" name="email">
      <input type="hidden" name="lead_id">
      <input type="hidden" name="lead_type" value="chat">
      <textarea name="message"></textarea>
      ${leadHoneypotField()}
    </form>
  </div>
</section>`;
}

function deadLetterRegistrar() {
  return `<form name="lead-dead-letter" method="POST" data-netlify="true" hidden aria-hidden="true" tabindex="-1">
  <input type="hidden" name="form-name" value="lead-dead-letter">
  <input type="hidden" name="alert">
  <input type="hidden" name="ingest_status">
  <input type="hidden" name="lead_id">
  <input type="hidden" name="name">
  <input type="hidden" name="phone">
  <input type="hidden" name="email">
  <input type="hidden" name="city">
  <input type="hidden" name="source">
  <input type="hidden" name="source_page">
  <input type="hidden" name="form_name">
  <input type="hidden" name="message">
</form>`;
}

function breadcrumbSchema(crumbs) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.label,
      item: c.href.startsWith("http") ? c.href : `${site.domain}${c.href}`,
    })),
  };
}

function localBusinessSchema() {
  const schema = {
    "@context": "https://schema.org",
    "@type": site.schemaTypes || ["HomeAndConstructionBusiness", "FenceContractor"],
    "@id": `${site.domain}/#localbusiness`,
    name: site.localName,
    alternateName: site.name,
    url: site.domain + "/",
    telephone: site.phoneTel,
    priceRange: site.priceRange,
    image: site.ogImage,
    sameAs: site.socialSameAs,
    brand: { "@type": "Brand", name: site.name },
    parentOrganization: {
      "@type": "Organization",
      name: site.name,
      url: site.parentUrl,
    },
    areaServed: site.areaServed.map((name) => ({ "@type": "City", name })),
    address: {
      "@type": "PostalAddress",
      addressLocality: site.address.locality,
      addressRegion: site.address.region,
      addressCountry: site.address.country,
    },
    identifier: {
      "@type": "PropertyValue",
      name: "California Contractors License",
      value: site.license,
    },
    description:
      site.schemaDescription ||
      `Licensed fence contractor serving ${site.address.locality} with installation, repair, wood, vinyl, chain link, gates, and commercial fencing.`,
  };
  if (site.geo && site.geo.latitude && site.geo.longitude) {
    schema.geo = {
      "@type": "GeoCoordinates",
      latitude: site.geo.latitude,
      longitude: site.geo.longitude,
    };
  }
  if (site.googleMapsUrl) {
    schema.hasMap = site.googleMapsUrl;
  }
  return schema;
}

function faqSchema(faqs = []) {
  if (!faqs.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: { "@type": "Answer", text: f.answer },
    })),
  };
}

function serviceSchema(page) {
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    name: page.h1,
    description: page.description,
    provider: { "@id": `${site.domain}/#localbusiness` },
    areaServed: site.areaServed.map((name) => ({ "@type": "City", name })),
    url: `${site.domain}${page.path}`,
  };
}

export function buildCrumbs(page) {
  const crumbs = [{ href: "/", label: "Home" }];
  const parts = page.path.split("/").filter(Boolean);
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    acc += `/${parts[i]}`;
    const isLast = i === parts.length - 1;
    const label = isLast
      ? page.h1
      : parts[i]
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
    crumbs.push({ href: `${acc}/`, label });
  }
  return crumbs;
}

function renderNav(currentPath) {
  return nav
    .map((item) => {
      const children = item.dropdown ? navMenus[item.dropdown] : item.children;
      if (children?.length) {
        const active = isDropdownActive(item.dropdown, currentPath, item.href, children);
        const links = children
          .map((child) => {
            const childActive = currentPath === child.href;
            return `<a href="${child.href}" role="menuitem"${childActive ? ' aria-current="page"' : ""}>${escapeHtml(child.label)}</a>`;
          })
          .join("");
        return `<div class="nav-dropdown"${active ? ' data-active="true"' : ""}>
  <a href="${item.href}" class="nav-dropdown-trigger" aria-haspopup="true" aria-expanded="false">${escapeHtml(item.label)}</a>
  <div class="nav-dropdown-panel" role="menu">${links}</div>
</div>`;
      }
      const active =
        item.href !== "/#contact" &&
        (currentPath === item.href || (item.href !== "/" && currentPath.startsWith(item.href)));
      return `<a href="${item.href}"${active ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}</a>`;
    })
    .join("");
}

function renderFooter() {
  const cols = footerColumns
    .map(
      (col) => `
    <div class="footer-col">
      <h3>${escapeHtml(col.title)}</h3>
      <ul>${col.links.map((l) => `<li><a href="${l.href}">${escapeHtml(l.label)}</a></li>`).join("")}</ul>
    </div>`
    )
    .join("");
  const cityCol = `
    <div class="footer-col">
      <h3>City Sites</h3>
      <ul>${citySites.map((c) => `<li><a href="${c.href}">${escapeHtml(c.label)}</a></li>`).join("")}</ul>
    </div>`;

  return `
<footer class="site-footer">
  <div class="footer-grid">${cols}${cityCol}</div>
  <div class="footer-bottom">
    <div>${escapeHtml(site.name)} — License #${site.license} — ${escapeHtml(site.address.locality)}, ${site.address.region} — <a href="tel:${site.phoneTel}">${site.phoneDisplay}</a></div>
    <div class="footer-legal"><a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · <a href="/sitemap.xml">Sitemap</a></div>
  </div>
</footer>`;
}

function renderBreadcrumbs(crumbs) {
  return `
<nav class="breadcrumbs" aria-label="Breadcrumb">
  <ol>${crumbs
    .map((c, i) => {
      const last = i === crumbs.length - 1;
      return `<li>${last ? `<span aria-current="page">${escapeHtml(c.label)}</span>` : `<a href="${c.href}">${escapeHtml(c.label)}</a>`}</li>`;
    })
    .join("")}</ol>
</nav>`;
}

export function renderLayout({
  title,
  description,
  path,
  canonical,
  body,
  schemas = [],
  includeHeroCanvas = false,
  includeCalculators = false,
  includeQuoteTool = false,
  ogType = "website",
  noindex = false,
}) {
  const url = canonical || `${site.domain}${path}`;
  const allSchemas = [localBusinessSchema(), ...schemas.filter(Boolean)];
  const schemaTags = allSchemas
    .map((s) => `<script type="application/ld+json">${JSON.stringify(s)}</script>`)
    .join("\n");
  const robots = noindex
    ? "noindex,follow"
    : "index,follow,max-image-preview:large";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="canonical" href="${url}">
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="${site.themeColor}">
<meta name="robots" content="${robots}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="${escapeHtml(site.localName)}">
<meta property="og:image" content="${site.ogImage}">
<meta property="og:image:alt" content="${escapeHtml(site.name)} — ${escapeHtml(site.address.locality)} fence contractors">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${site.ogImage}">
<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192x192.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="stylesheet" href="/assets/css/site.css?v=${assetVersion}">
<link rel="stylesheet" href="/assets/css/content.css?v=${assetVersion}">
<style>
.nav-dropdown{position:relative;display:inline-flex;align-items:center}
.nav-dropdown-panel{display:none!important;position:absolute;top:100%;left:0;z-index:60;grid-template-columns:1fr;gap:.15rem;min-width:15.5rem;max-height:min(70vh,28rem);overflow:auto;padding:.65rem .55rem .55rem;border:1px solid rgba(212,168,83,.22);border-radius:6px;background:rgba(10,10,10,.97);box-shadow:0 18px 50px rgba(0,0,0,.45);margin-top:0}
.nav-dropdown:hover .nav-dropdown-panel,.nav-dropdown:focus-within .nav-dropdown-panel,.nav-dropdown.is-open .nav-dropdown-panel{display:grid!important;pointer-events:auto}
.nav-dropdown-panel a{display:block;padding:.55rem .7rem;border-radius:4px;color:rgba(255,255,255,.78);font-size:.76rem;letter-spacing:.06em;text-decoration:none;text-transform:none;white-space:nowrap}
.nav-dropdown-panel a:hover,.nav-dropdown-panel a:focus-visible{background:rgba(212,168,83,.12);color:var(--gold)}
@media(max-width:780px){.nav-dropdown{display:block;width:100%}.nav-dropdown-panel{position:static;width:100%;max-height:none;margin-top:.35rem;padding:.55rem;box-shadow:none}}
</style>
${includeHeroCanvas ? '<link rel="preload" href="/assets/js/site.js" as="script">' : ""}
${schemaTags}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand-link" href="/">${escapeHtml(site.name)}</a>
    <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="site-nav" data-nav-toggle>
      <span class="sr-only">Menu</span>
      <span aria-hidden="true"></span>
    </button>
    <nav id="site-nav" class="site-nav" aria-label="Main">${renderNav(path)}</nav>
    <a class="top-call" href="tel:${site.phoneTel}" aria-label="Call Twin Rivers Fence at ${site.phoneDisplay}">Call ${site.phoneDisplay}</a>
  </div>
</header>
<main id="main">
${body}
</main>
${renderFooter()}
<div class="sticky-call-bar" aria-label="Call for a free estimate">
  <a href="tel:${site.phoneTel}">Call ${site.phoneDisplay} � Free Estimate</a>
</div>
${
  includeHeroCanvas
    ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js" defer></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/ScrollTrigger.min.js" defer></script>`
    : ""
}
${deadLetterRegistrar()}
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script src="/assets/js/site.js?v=${assetVersion}" defer></script>
<script src="/assets/js/google-reviews.js?v=${assetVersion}" defer></script>
${includeCalculators ? `<script src="/assets/js/calculators.js?v=${assetVersion}" defer></script>` : ""}
${includeQuoteTool ? `<script src="/assets/js/fence-pricing.js?v=${assetVersion}" defer></script>
<script src="/assets/js/quote-calculator.js?v=${assetVersion}" defer></script>` : ""}
<script src="/assets/js/nav.js?v=${assetVersion}" defer></script>
</body>
</html>`;
}

export { escapeHtml, breadcrumbSchema, faqSchema, serviceSchema, renderBreadcrumbs, localBusinessSchema, leadHoneypotField, turnstileWidget, riverContactSection };
