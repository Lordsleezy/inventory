/**
 * Layered tracking extraction from uploaded shipping labels.
 * Text (pdfjs) → barcode (embedded image / render) → optional OCR.
 */
import {
  classifyCarrier,
  isPostagePermitId,
  validateTrackingCandidate,
  digitsOnly,
  alphaNumOnly,
  completeUspsFromBody,
} from "../../shared/tracking-validate.mjs";
import { compactTracking } from "../../shared/tracking-normalize.mjs";
import {
  decodeTrackingBarcodes,
} from "./tracking-barcode.mjs";
import {
  extractEmbeddedJpegs,
  extractPdfPagesText,
  extractPdfTextLegacy,
  itemNearTracking,
  scoreLabelPage,
  trackingAnchors,
} from "./tracking-pdf.mjs";

export { compactTracking } from "../../shared/tracking-normalize.mjs";

/** @deprecated Use extractPdfPagesText; kept for tests. */
export async function extractPdfText(bytes) {
  try {
    const { pages } = await extractPdfPagesText(bytes);
    return pages.map((p) => p.text).join("\n");
  } catch {
    return extractPdfTextLegacy(bytes);
  }
}

function joinDigitGroups(text) {
  const raw = String(text || "");
  const spaced = raw.match(/(?:\d{4}[\s\-]+){3,7}\d{1,4}/g) || [];
  const joined = spaced.map((line) => line.replace(/[\s\-]+/g, ""));
  const compacted = raw.replace(/(?<=\d)[\s\-]+(?=\d)/g, "");
  return `${raw}\n${joined.join("\n")}\n${compacted}`;
}

function rejectRuns(runs, blocked) {
  const block = new Set(blocked.filter(Boolean));
  return runs.filter((r) => {
    if (block.has(r.number)) return false;
    if (isPostagePermitId(r.number)) return false;
    if (/^\d{5,9}$/.test(r.number)) return false;
    return true;
  });
}

function filenameBlockedNumbers(filename) {
  const name = String(filename || "");
  const blocked = [];
  for (const m of name.matchAll(/\d{2,}[\-\s]\d{2,}[\-\s]\d{2,}/g)) blocked.push(m[0].replace(/\D/g, ""));
  const all = name.replace(/\D/g, "");
  if (all.length >= 12 && all.length <= 22) blocked.push(all);
  return blocked;
}

function collectCandidatesFromText(text, { nearTracking = false, blocked = [] } = {}) {
  const near = nearTracking || /tracking|trk\s*#|usps\s+tracking/i.test(text);
  const corpus = joinDigitGroups(text);
  const found = new Map();
  const add = (number, score, source) => {
    const v = validateTrackingCandidate(number, { nearTrackingLabel: near });
    if (!v) return;
    const row = { ...v, score: v.score + score, source };
    const prev = found.get(row.number);
    if (!prev || prev.score < row.score) found.set(row.number, row);
  };

  for (const m of corpus.matchAll(/\b420\d{5}(9[2-5]\d{18,24})\b/gi)) add(m[1], 5, "barcode-text");
  for (const m of corpus.matchAll(/\b420\d{9}(9[2-5]\d{18,24})\b/gi)) add(m[1], 5, "barcode-text");
  for (const m of corpus.matchAll(/\b(9[2-5]\d{18,24})\b/g)) add(m[1], 0, "text");
  for (const m of corpus.matchAll(/\b(\d{18,20})\b/g)) {
    if (/^9[2-5]/.test(m[1])) continue;
    const completed = completeUspsFromBody(m[1]);
    if (completed) add(completed, 3, "text-body");
  }
  for (const m of corpus.matchAll(/\b(1Z[0-9A-Z]{16})\b/gi)) add(m[1], 1, "text");
  if (/fedex/i.test(corpus)) {
    for (const m of corpus.matchAll(/\b(\d{12}|\d{15}|\d{20})\b/g)) {
      if (!/^9[2-5]/.test(m[1])) add(m[1], 0, "text-fedex");
    }
  }

  const permit = corpus.match(/\b0\d{2}W\d{10,}\b/gi) || [];
  for (const p of permit) {
    const d = alphaNumOnly(p);
    if (found.has(d)) found.delete(d);
  }

  return rejectRuns([...found.values()].sort((a, b) => b.score - a.score || a.number.localeCompare(b.number)), blocked);
}

function pickPage(pages) {
  if (!pages.length) return null;
  const scored = pages.map((p) => ({ p, score: scoreLabelPage(p) })).sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].p : pages[0];
}

function finalizeCandidates(list) {
  const strong = list.filter((x) => x.score >= 8);
  const unique = [];
  const seen = new Set();
  for (const row of strong.length ? strong : list) {
    if (seen.has(row.number)) continue;
    seen.add(row.number);
    unique.push(row);
  }
  if (unique.length === 1) {
    return {
      confident: true,
      number: unique[0].number,
      carrier: unique[0].carrier || classifyCarrier(unique[0].number),
      alternatives: list,
      layer: unique[0].layer || unique[0].source || "text",
    };
  }
  if (unique.length > 1) {
    return { confident: false, reason: "multiple", alternatives: unique, needsPicker: true, layer: "text" };
  }
  if (list.length) {
    return { confident: false, reason: "weak", alternatives: list, needsPicker: true, layer: "text" };
  }
  return { confident: false, reason: "none", alternatives: [], needsPicker: false, layer: "none" };
}

export function parseTracking(text, opts = {}) {
  const list = collectCandidatesFromText(text, opts);
  return { ...finalizeCandidates(list), alternatives: list };
}

export async function ocrImage(bytes) {
  let createWorker;
  try {
    ({ createWorker } = await import("tesseract.js"));
  } catch {
    return { text: "", engine: "none" };
  }
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const langPath = join(dirname(fileURLToPath(import.meta.url)), "..", "traineddata");
  const worker = await createWorker("eng", 1, { langPath, errorHandler: () => {} });
  try {
    const sharp = (await import("sharp")).default;
    const bottom = await sharp(bytes).metadata().then(async (meta) => {
      const h = meta.height || 800;
      const crop = Math.floor(h * 0.42);
      return sharp(bytes).extract({ left: 0, top: Math.max(0, h - crop), width: meta.width || 800, height: crop }).png().toBuffer();
    });
    const { data } = await worker.recognize(bottom);
    return { text: data?.text || "", engine: "tesseract" };
  } finally {
    await worker.terminate();
  }
}

async function extractFromPdf(bytes, opts) {
  const blocked = filenameBlockedNumbers(opts.filename);
  const layers = [];

  let pages = [];
  try {
    const parsed = await extractPdfPagesText(bytes);
    pages = parsed.pages || [];
  } catch {
    pages = [];
  }

  if (pages.length) {
    const labelPage = pickPage(pages);
    const anchors = trackingAnchors(labelPage?.items);
    const nearText = (labelPage?.items || [])
      .filter((it) => /\d/.test(it.str))
      .map((it) => it.str)
      .join(" ");
    const body = `${labelPage?.text || ""}\n${nearText}`;
    const fromAnchors = collectCandidatesFromText(body, {
      nearTracking: anchors.length > 0,
      blocked,
    });
    for (const row of fromAnchors) {
      if (itemNearTracking({ y: 0 }, anchors, labelPage?.height)) row.score += 2;
    }
    if (fromAnchors.length) layers.push({ layer: "pdf-text", list: fromAnchors });

    if (pages.length > 1 && pages.every((p) => scoreLabelPage(p) < 4)) {
      return { confident: false, reason: "multi_page", alternatives: [], needsPicker: true, layer: "multi" };
    }
  } else {
    const legacy = extractPdfTextLegacy(bytes);
    const fromLegacy = collectCandidatesFromText(legacy, { blocked });
    if (fromLegacy.length) layers.push({ layer: "pdf-text-legacy", list: fromLegacy });
  }

  const jpegs = extractEmbeddedJpegs(bytes);
  for (const img of jpegs) {
    try {
      const codes = await decodeTrackingBarcodes(img);
      if (codes.length) {
        layers.push({
          layer: "barcode",
          list: codes.map((c) => ({
            number: c.number,
            carrier: c.carrier,
            score: 20,
            source: "barcode",
            layer: "barcode",
          })),
        });
      }
    } catch { /* next image */ }
  }

  const merged = new Map();
  for (const tier of layers) {
    for (const row of tier.list) {
      const prev = merged.get(row.number);
      if (!prev || prev.score < row.score) merged.set(row.number, row);
    }
  }
  let list = [...merged.values()].sort((a, b) => b.score - a.score);
  list = rejectRuns(list, blocked);

  if (list.some((r) => r.layer === "barcode" || r.source === "barcode")) {
    const bar = list.filter((r) => r.layer === "barcode" || r.source === "barcode");
    if (bar.length === 1) {
      return {
        confident: true,
        number: bar[0].number,
        carrier: bar[0].carrier || classifyCarrier(bar[0].number),
        alternatives: list,
        layer: "barcode",
        needsPicker: false,
      };
    }
    if (bar.length > 1) {
      return { confident: false, reason: "multiple", alternatives: bar, needsPicker: true, layer: "barcode" };
    }
  }

  const textPick = finalizeCandidates(list);
  if (!textPick.confident && textPick.reason === "none" && jpegs.length) {
    const ocr = await ocrImage(jpegs[0]);
    if (ocr.text) {
      const ocrList = collectCandidatesFromText(ocr.text, { nearTracking: true, blocked });
      if (ocrList.length) return { ...finalizeCandidates(ocrList), engine: ocr.engine, layer: "ocr", text: ocr.text.slice(0, 500) };
    }
  }

  return { ...textPick, engine: "pdf", text: pages[0]?.text?.slice(0, 2000) || "" };
}

export async function extractTrackingFromFile(bytes, mime, opts = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const type = String(mime || "").toLowerCase();
  const isPdf = type.includes("pdf") || buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (isPdf) return extractFromPdf(buf, opts);

  if (type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(opts.filename || "")) {
    const codes = await decodeTrackingBarcodes(buf);
    if (codes.length === 1) {
      return {
        confident: true,
        number: codes[0].number,
        carrier: codes[0].carrier,
        alternatives: codes,
        layer: "barcode",
        engine: "image",
      };
    }
    if (codes.length > 1) {
      return { confident: false, reason: "multiple", alternatives: codes, needsPicker: true, layer: "barcode", engine: "image" };
    }
    const ocr = await ocrImage(buf);
    if (ocr.engine !== "none") return { ...parseTracking(ocr.text, { blocked: filenameBlockedNumbers(opts.filename) }), engine: ocr.engine, layer: "ocr" };
    return { confident: false, reason: "none", alternatives: [], needsPicker: false, engine: "none" };
  }

  const ocr = await ocrImage(buf);
  if (ocr.engine === "none") {
    return { confident: false, reason: "ocr_unavailable", alternatives: [], engine: "none", text: "" };
  }
  return { ...parseTracking(ocr.text, { blocked: filenameBlockedNumbers(opts.filename) }), engine: ocr.engine, layer: "ocr", text: String(ocr.text || "").slice(0, 2000) };
}

export function trackingUrlFor(carrier, tracking) {
  const n = encodeURIComponent(String(tracking || "").replace(/\s+/g, ""));
  const c = String(carrier || "").toLowerCase();
  if (c.includes("usps") || c.includes("postal")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${n}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  return null;
}
