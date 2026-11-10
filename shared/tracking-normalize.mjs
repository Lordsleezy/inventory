import { uspsCheckDigitValid } from "./tracking-validate.mjs";
import { completeUspsFromBody } from "./tracking-validate.mjs";

function bestUspsSubstring(n) {
  const hits = [];
  for (const m of n.matchAll(/9[2-5]\d{18,24}/g)) {
    if (uspsCheckDigitValid(m[0])) hits.push(m[0]);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.length - a.length || n.lastIndexOf(b) - n.lastIndexOf(a));
  return hits[0];
}

function preferUspsLength(hits) {
  if (hits.length === 1) return hits[0];
  const rank = (len) => {
    const i = [22, 20, 26, 30, 34].indexOf(len);
    return i === -1 ? 99 : i;
  };
  hits.sort((a, b) => rank(a.length) - rank(b.length) || b.length - a.length);
  return hits[0];
}

/**
 * `(420)` is the ZIP. `(94)` and the digits after it are the tracking number.
 * The 94 is part of the number stored on the order.
 */
function uspsFromGs1(value) {
  const marked = String(value || "").match(/\(9([1-5])\)(\d{18,32})/);
  if (!marked) return null;
  const number = `9${marked[1]}${marked[2]}`;
  return /^9[1-5]\d{19,33}$/.test(number) ? number : null;
}

/**
 * A 420 routing barcode is 420, then a 5-, 9-, or 11-digit ZIP, then the tracking number.
 * A valid check digit wins. A normal-length 91–95 number still counts when the digit does not,
 * so the scan is not chopped down to a FedEx last-12.
 */
function uspsAfterRouting(digits) {
  if (!digits.startsWith("420")) return null;
  const valid = [];
  const shaped = [];
  for (const zipLen of [5, 9, 11]) {
    const rest = digits.slice(3 + zipLen);
    if (!/^9[1-5]\d{17,32}$/.test(rest)) continue;
    if (uspsCheckDigitValid(rest)) valid.push(rest);
    else shaped.push(rest);
  }
  if (valid.length) return preferUspsLength(valid);
  if (shaped.length) return preferUspsLength(shaped);
  return null;
}

/** `]C1` / `]d2` symbology prefixes become a leading letter before the barcode. */
function withoutAimPrefix(value) {
  return String(value || "").replace(/^[A-Z]\d?(?=420|9[1-5]|1Z)/, "");
}

/** Normalize carrier barcodes for lookup (USPS 420+ZIP wrappers, UPS 1Z, FedEx 34-digit). */
export function compactTracking(value) {
  const n = withoutAimPrefix(String(value || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase());
  if (!n) return "";
  const ups = n.match(/1Z[0-9A-Z]{16}/);
  if (ups) return ups[0];

  const gs1 = uspsFromGs1(value);
  if (gs1) return gs1;

  const digits = n.replace(/[A-Z]/g, "");
  const routed = uspsAfterRouting(digits);
  if (routed) return routed;

  if (/^9[1-5]\d{17,32}$/.test(digits) && uspsCheckDigitValid(digits)) return digits;

  const fromSub = bestUspsSubstring(digits);
  if (fromSub) return fromSub;

  const completed = completeUspsFromBody(digits);
  if (completed) return completed;

  if (/^\d{34}$/.test(digits)) return digits.slice(-12);
  return n;
}

export function trackingSuffix(value) {
  const c = compactTracking(value);
  return c.length >= 12 ? c.slice(-12) : c;
}

/**
 * Parentheses are labels around digits, not a break in the number.
 * The saved tracking number has to be long enough that a ZIP, a SKU,
 * or a 12-digit tail cannot hit a different package.
 */
export function scanContainsTracking(scanned, stored) {
  const track = compactTracking(stored);
  if (!track || track.length < 18) return false;
  const scan = String(scanned || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return scan.length >= track.length && scan.includes(track);
}

function routingOnly(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return /^420\d{5}$/.test(digits) || /^420\d{9}$/.test(digits) || /^420\d{11}$/.test(digits);
}

/**
 * One physical label. ZIP+4 (9) is tried before a 5-digit ZIP so the next
 * barcode's digits are not swallowed into this tracking number.
 */
function matchLabelBarcode(after) {
  for (const zipLen of [9, 5, 11]) {
    for (const trackLen of [22, 20, 26, 30, 34]) {
      const payload = trackLen - 2;
      const re = new RegExp(`^\\(?420\\)?\\d{${zipLen}}\\(?9[1-5]\\)?\\d{${payload}}(?!\\d)`, "i");
      const hit = after.match(re);
      if (hit) return hit[0];
    }
  }
  return null;
}

function extractLabelBarcodes(text) {
  const flat = String(text || "").replace(/[\u001d\u001e\r\n]/g, "");
  const scans = [];
  const start = /\(?420\)?/gi;
  let mark;
  while ((mark = start.exec(flat))) {
    const raw = matchLabelBarcode(flat.slice(mark.index));
    if (!raw) continue;
    scans.push(raw);
    start.lastIndex = mark.index + raw.length;
  }
  return { flat, scans };
}

/**
 * A scanner may send the ZIP, then Enter, then the tracking number.
 * It may also leave the previous label in the box. Each returned scan is one label.
 * `held` is a ZIP that is still waiting for its tracking number.
 */
export function takeLabelScans(raw, held = "") {
  const incoming = String(raw || "").replace(/[\u001d\u001e]/g, "");
  const own = extractLabelBarcodes(incoming);
  if (own.scans.length) {
    const tail = own.flat.slice(own.flat.lastIndexOf(own.scans[own.scans.length - 1]) + own.scans[own.scans.length - 1].length);
    return { scans: own.scans, held: routingOnly(tail) ? tail : "" };
  }
  const text = `${held || ""}${incoming}`;
  const joined = extractLabelBarcodes(text);
  if (joined.scans.length) return { scans: joined.scans, held: "" };
  if (routingOnly(text)) return { scans: [], held: text };
  const trimmed = text.trim();
  if (!trimmed) return { scans: [], held: "" };
  return { scans: [trimmed], held: "" };
}
