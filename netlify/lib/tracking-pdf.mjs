/**
 * PDF text and image extraction for shipping labels (pdfjs + embedded JPEG streams).
 */
import { compactTracking } from "../../shared/tracking-normalize.mjs";

let pdfjsModule;

async function getPdfJs() {
  if (!pdfjsModule) {
    pdfjsModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsModule;
}

export async function extractPdfPagesText(bytes) {
  const { getDocument } = await getPdfJs();
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((it) => it.str && String(it.str).trim())
      .map((it) => ({
        str: String(it.str),
        x: it.transform?.[4] ?? 0,
        y: it.transform?.[5] ?? 0,
      }));
    pages.push({
      page: p,
      items,
      text: items.map((i) => i.str).join("\n"),
      width: page.view?.[2] ?? 0,
      height: page.view?.[3] ?? 0,
    });
  }
  return { numPages: doc.numPages, pages };
}

import { inflateSync } from "node:zlib";

/** Naive inflater used when pdfjs is unavailable in a tiny test stub. */
export function extractPdfTextLegacy(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const chunks = [buf];
  const src = buf.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(src))) {
    const raw = Buffer.from(m[1], "latin1");
    try { chunks.push(inflateSync(raw)); } catch { chunks.push(raw); }
  }
  const unescapePdf = (s) => String(s || "")
    .replace(/\\n/g, "\n")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
  const out = [];
  for (const c of chunks) {
    const s = c.toString("latin1");
    const lit = /\((?:\\.|[^\\)]){2,}\)/g;
    let hit;
    while ((hit = lit.exec(s))) out.push(unescapePdf(hit[0].slice(1, -1)));
  }
  return out.join("\n");
}

export function extractEmbeddedJpegs(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const out = [];
  let off = 0;
  while (off < buf.length - 4) {
    const idx = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]), off);
    if (idx < 0) break;
    let end = buf.indexOf(Buffer.from([0xff, 0xd9]), idx + 2);
    if (end < 0) break;
    end += 2;
    const chunk = buf.subarray(idx, end);
    if (chunk.length > 1000) out.push(chunk);
    off = end;
  }
  return out;
}

export function scoreLabelPage(page) {
  const t = page.text || "";
  let score = 0;
  if (/tracking|trk\s*#|usps\s+tracking/i.test(t)) score += 12;
  if (/ship\s*to|postage|usps|ups|fedex/i.test(t)) score += 4;
  if (/(?:\d{4}\s+){3,}\d{2,4}/.test(t)) score += 8;
  const w = page.width || 0;
  const h = page.height || 0;
  if (w && h && w < h * 1.2 && h > 400) score += 3;
  if (/invoice|packing\s*slip|order\s*summary/i.test(t) && !/tracking/i.test(t)) score -= 10;
  return score;
}

export function trackingAnchors(items) {
  const anchors = [];
  for (const it of items || []) {
    if (/tracking|trk\s*#|usps\s+tracking/i.test(it.str)) anchors.push({ y: it.y, x: it.x });
  }
  return anchors;
}

export function itemNearTracking(item, anchors, pageHeight = 800) {
  if (!anchors.length) return false;
  return anchors.some((a) => Math.abs(a.y - item.y) < pageHeight * 0.35);
}

export function normalizeBarcodeTracking(raw) {
  const n = compactTracking(raw);
  return n || null;
}
