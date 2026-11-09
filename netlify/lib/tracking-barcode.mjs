import sharp from "sharp";
import { normalizeBarcodeTracking } from "./tracking-pdf.mjs";
import { classifyCarrier, validateTrackingCandidate } from "../../shared/tracking-validate.mjs";

/**
 * Decode Code 128 / GS1 tracking barcodes from a raster image buffer (JPEG/PNG).
 * @returns {{ raw: string, number: string, carrier: string, layer: string }[]}
 */
export async function decodeTrackingBarcodes(imageBuf) {
  const meta = await sharp(imageBuf).metadata();
  const targetW = Math.min(Math.max(meta.width || 800, 400), 2400);
  const { data, info } = await sharp(imageBuf)
    .rotate()
    .resize({ width: targetW, withoutEnlargement: false })
    .normalize()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let symbols = [];
  try {
    const { scanRGBABuffer } = await import("@undecaf/zbar-wasm");
    symbols = await scanRGBABuffer(data, info.width, info.height);
  } catch {
    symbols = [];
  }

  const out = [];
  const seen = new Set();
  for (const sym of symbols) {
    const raw = String(sym.decode?.() || sym.data || "").trim();
    if (!raw) continue;
    const number = normalizeBarcodeTracking(raw);
    if (!number || seen.has(number)) continue;
    const v = validateTrackingCandidate(number, { nearTrackingLabel: true });
    if (!v) continue;
    seen.add(number);
    out.push({
      raw,
      number: v.number,
      carrier: v.carrier || classifyCarrier(v.number) || "USPS",
      layer: "barcode",
    });
  }
  return out;
}
