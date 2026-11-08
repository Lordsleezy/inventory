/**
 * Pull a carrier tracking number out of a Depop label.
 * PDFs: read the text operators (Depop's download is a text PDF).
 * Screenshots: Tesseract when the package is installed; otherwise ask the user.
 * A guess is only accepted when exactly one strong number is present.
 */
import { inflateSync } from "node:zlib";

function unescapePdf(s) {
  return String(s || "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8) & 0xff));
}

function stringsFrom(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf || "");
  const out = [];
  const lit = /\((?:\\.|[^\\)]){2,}\)/g;
  let m;
  while ((m = lit.exec(s))) out.push(unescapePdf(m[0].slice(1, -1)));
  const hex = /<([0-9A-Fa-f\s]{8,})>/g;
  while ((m = hex.exec(s))) {
    const body = m[1].replace(/\s/g, "");
    if (body.length % 2) continue;
    try { out.push(Buffer.from(body, "hex").toString("latin1")); } catch { /* skip */ }
  }
  return out;
}

/** Best-effort text from a shipping-label PDF. No native PDF library. */
export function extractPdfText(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const chunks = [buf];
  const src = buf.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(src))) {
    const raw = Buffer.from(m[1], "latin1");
    try { chunks.push(inflateSync(raw)); } catch { chunks.push(raw); }
  }
  return chunks.flatMap(stringsFrom).join("\n");
}

function addCandidate(found, number, carrier, score) {
  const n = String(number || "").replace(/\s+/g, "").toUpperCase();
  if (n.length < 10 || n.length > 40) return;
  const prev = found.get(n);
  if (!prev || prev.score < score) found.set(n, { number: n, carrier, score });
}

/**
 * @returns {{ confident: boolean, number?: string, carrier?: string, reason?: string, alternatives: {number:string,carrier:string,score:number}[] }}
 */
export function parseTracking(text) {
  const raw = String(text || "");
  const joined = raw.replace(/(\d)[ \t]+(?=\d)/g, "$1");
  const found = new Map();

  for (const m of joined.matchAll(/\b420\d{5}(9[2-5]\d{18,24})\b/g)) addCandidate(found, m[1], "USPS", 4);
  for (const m of joined.matchAll(/\b420\d{9}(9[2-5]\d{18,24})\b/g)) addCandidate(found, m[1], "USPS", 4);
  for (const m of joined.matchAll(/\b(9[2-5]\d{18,24})\b/g)) addCandidate(found, m[1], "USPS", 3);
  for (const m of joined.matchAll(/\b(1Z[0-9A-Z]{16})\b/gi)) addCandidate(found, m[1], "UPS", 3);
  if (/fedex/i.test(raw)) {
    for (const m of joined.matchAll(/\b(\d{12}|\d{15}|\d{20}|\d{22})\b/g)) {
      if (!/^9[2-5]/.test(m[1])) addCandidate(found, m[1], "FedEx", 2);
    }
  }

  const list = [...found.values()].sort((a, b) => b.score - a.score || a.number.localeCompare(b.number));
  const strong = list.filter((x) => x.score >= 3);
  const uniqueStrong = [];
  const seen = new Set();
  for (const row of strong) {
    if (seen.has(row.number)) continue;
    seen.add(row.number);
    uniqueStrong.push(row);
  }
  if (uniqueStrong.length === 1) {
    return { confident: true, number: uniqueStrong[0].number, carrier: uniqueStrong[0].carrier, alternatives: list };
  }
  if (uniqueStrong.length > 1) return { confident: false, reason: "multiple", alternatives: uniqueStrong };
  return { confident: false, reason: list.length ? "weak" : "none", alternatives: list };
}

export async function ocrImage(bytes) {
  let createWorker;
  try {
    ({ createWorker } = await import("tesseract.js"));
  } catch {
    return { text: "", engine: "none" };
  }
  const worker = await createWorker("eng", 1, { errorHandler: () => {} });
  try {
    const { data } = await worker.recognize(Buffer.from(bytes));
    return { text: data?.text || "", engine: "tesseract" };
  } finally {
    await worker.terminate();
  }
}

export async function extractTrackingFromFile(bytes, mime) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const type = String(mime || "").toLowerCase();
  const isPdf = type.includes("pdf") || buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (isPdf) {
    const text = extractPdfText(buf);
    return { ...parseTracking(text), engine: "pdf", text: text.slice(0, 2000) };
  }
  const ocr = await ocrImage(buf);
  if (ocr.engine === "none") {
    return { confident: false, reason: "ocr_unavailable", alternatives: [], engine: "none", text: "" };
  }
  return { ...parseTracking(ocr.text), engine: ocr.engine, text: String(ocr.text || "").slice(0, 2000) };
}

/** Compare eBay's number and a PDF number. A 420+ZIP wrapper is the same USPS number. */
export function compactTracking(value) {
  const n = String(value || "").replace(/\s+/g, "").toUpperCase();
  const wrapped = n.match(/^420\d{5}(9[2-5]\d{18,24})$/) || n.match(/^420\d{9}(9[2-5]\d{18,24})$/);
  return wrapped ? wrapped[1] : n;
}

export function trackingUrlFor(carrier, tracking) {
  const n = encodeURIComponent(String(tracking || "").replace(/\s+/g, ""));
  const c = String(carrier || "").toLowerCase();
  if (c.includes("usps") || c.includes("postal")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${n}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  return null;
}
