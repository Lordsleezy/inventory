import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pages } from "./src/data/pages.js";
import { calculatorPages } from "./src/data/calculators.js";
import { site } from "./src/data/site.js";
import { renderContentPage } from "./src/templates/page.js";
import { renderHomePage } from "./src/templates/home.js";
import { renderLayout, escapeHtml } from "./src/templates/layout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "dist");

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writePage(urlPath, html) {
  const clean = urlPath.endsWith("/") ? urlPath : `${urlPath}/`;
  const out =
    clean === "/"
      ? path.join(dist, "index.html")
      : path.join(dist, clean.slice(1), "index.html");
  ensureDir(out);
  fs.writeFileSync(out, html);
  return clean;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function renderLegal(kind) {
  const isPrivacy = kind === "privacy";
  const title = isPrivacy
    ? "Privacy Policy | Sacramento Gate Installation"
    : "Terms of Service | Sacramento Gate Installation";
  const h1 = isPrivacy ? "Privacy Policy" : "Terms of Service";
  const pathUrl = isPrivacy ? "/privacy/" : "/terms/";
  const body = `
<section class="page-hero">
  <p class="eyebrow">Twin Rivers Fence</p>
  <h1>${h1}</h1>
  <p class="sub">Last updated: July 20, 2026</p>
</section>
<section class="dark-section content-block">
  <div class="prose">
    ${
      isPrivacy
        ? `<p>This privacy policy explains how Twin Rivers Fence (“we”) handles information submitted through gateinstallationsacramento.com contact forms and phone inquiries.</p>
    <h2>Information we collect</h2>
    <p>When you request an estimate, we may collect your name, phone number, email address, and project details you choose to share.</p>
    <h2>How we use information</h2>
    <p>We use contact details to respond to your inquiry, schedule site visits, and provide fencing quotes. We do not sell personal information.</p>
    <h2>Contact</h2>
    <p>Questions about privacy: call <a href="tel:${site.phoneTel}">${site.phoneDisplay}</a>.</p>`
        : `<p>By using gateinstallationsacramento.com you agree to these terms.</p>
    <h2>Estimates</h2>
    <p>Online calculators and guides provide educational estimates only. Binding pricing requires a site-specific quote from Twin Rivers Fence.</p>
    <h2>Services</h2>
    <p>Fence installation and related work are performed under California contractor license #${site.license}. Project scope, warranty terms, and payment details are confirmed in writing for each job.</p>
    <h2>Contact</h2>
    <p>Call <a href="tel:${site.phoneTel}">${site.phoneDisplay}</a> for questions about these terms.</p>`
    }
  </div>
</section>`;
  return renderLayout({ title, description: `${h1} for Sacramento Gate Installation.`, path: pathUrl, body });
}

function renderSuccess() {
  const body = `
<section class="page-hero">
  <p class="eyebrow">Thank you</p>
  <h1>Message received</h1>
  <p class="sub">We will review your project details and follow up soon. For faster service, call <a href="tel:${site.phoneTel}">${site.phoneDisplay}</a>.</p>
  <a class="btn-gold" href="/">Back to home</a>
</section>`;
  return renderLayout({
    title: "Message Sent | Twin Rivers Fence",
    description: "Your message was sent to Sacramento Gate Installation.",
    path: "/success/",
    body,
  });
}

function buildSitemap(urls) {
  const today = new Date().toISOString().slice(0, 10);
  const entries = urls
    .map(
      (u) => `  <url>
    <loc>${site.domain}${u}</loc>
    <lastmod>${today}</lastmod>
  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

function main() {
  rmrf(dist);
  fs.mkdirSync(dist, { recursive: true });

  const urls = [];
  const redirectedToHome = new Set([]);

  urls.push(writePage("/", renderHomePage()));

  for (const page of pages) {
    if (redirectedToHome.has(page.path)) continue;
    const url = writePage(page.path, renderContentPage(page));
    if (!page.noindex) urls.push(url);
  }

  for (const page of calculatorPages) {
    urls.push(
      writePage(
        page.path,
        renderContentPage(
          {
            ...page,
            type: page.calculatorId ? "resource" : "hub",
            sections: page.sections || [],
          },
          {
            calculatorId: page.calculatorId,
            howItWorks: page.howItWorks,
            assumptions: page.assumptions,
          }
        )
      )
    );
  }

  urls.push(writePage("/privacy/", renderLegal("privacy")));
  urls.push(writePage("/terms/", renderLegal("terms")));
  urls.push(writePage("/success/", renderSuccess()));

  // Assets
  fs.mkdirSync(path.join(dist, "assets/css"), { recursive: true });
  fs.mkdirSync(path.join(dist, "assets/js"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "src/styles/site.css"), path.join(dist, "assets/css/site.css"));
  fs.copyFileSync(path.join(__dirname, "src/styles/content.css"), path.join(dist, "assets/css/content.css"));
  fs.copyFileSync(path.join(__dirname, "src/scripts/site.js"), path.join(dist, "assets/js/site.js"));
  fs.copyFileSync(path.join(__dirname, "src/scripts/google-reviews.js"), path.join(dist, "assets/js/google-reviews.js"));
  fs.copyFileSync(path.join(__dirname, "src/scripts/calculators.js"), path.join(dist, "assets/js/calculators.js"));
  fs.copyFileSync(path.join(__dirname, "src/scripts/nav.js"), path.join(dist, "assets/js/nav.js"));
  fs.copyFileSync(path.join(__dirname, "src/scripts/fence-pricing.js"), path.join(dist, "assets/js/fence-pricing.js"));
  fs.copyFileSync(path.join(__dirname, "src/scripts/quote-calculator.js"), path.join(dist, "assets/js/quote-calculator.js"));

  if (fs.existsSync(path.join(__dirname, "public"))) {
    copyDir(path.join(__dirname, "public"), dist);
  }

  const uniqueUrls = [...new Set(urls)].sort();
  fs.writeFileSync(path.join(dist, "sitemap.xml"), buildSitemap(uniqueUrls));
  fs.writeFileSync(
    path.join(dist, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${site.domain}/sitemap.xml\n`
  );

  // Netlify form detection helper (hidden form on a static file is enough if forms exist in HTML)
  console.log(`Built ${uniqueUrls.length} routes into dist/`);
  uniqueUrls.forEach((u) => console.log(`  ${u}`));
}

main();


