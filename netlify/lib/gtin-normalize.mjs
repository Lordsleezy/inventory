/**
 * Normalize scanned barcodes to GTIN-14 (and UPC-A / EAN-13 forms).
 * Supports UPC-A (12), EAN-13 (13), GTIN-14, and UPC-E (6–8).
 */
import { gtinIssue, isCostcoInternalCode } from "./gtin.mjs";

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function checkDigit(body) {
  let sum = 0;
  for (let i = body.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(body[i]) * weight;
  }
  return String((10 - (sum % 10)) % 10);
}

/** Expand UPC-E (6–8 digits, optional number system + check) to UPC-A (12). */
export function expandUpcE(raw) {
  let d = digitsOnly(raw);
  let ns = "0";
  if (d.length === 8) {
    ns = d[0];
    d = d.slice(1, 7); // drop NS + check, keep middle 6
  } else if (d.length === 7) {
    // Could be NS+6 or 6+check — treat as 6+check when leading digit is 0/1 with valid expand
    d = d.slice(0, 6);
  }
  if (d.length !== 6) return null;
  const [n2, n3, n4, n5, n6, n7] = d.split("");
  let mid;
  if ("012".includes(n7)) mid = `${n2}${n3}${n7}0000${n4}${n5}${n6}`;
  else if (n7 === "3") mid = `${n2}${n3}${n4}00000${n5}${n6}`;
  else if (n7 === "4") mid = `${n2}${n3}${n4}${n5}00000${n6}`;
  else mid = `${n2}${n3}${n4}${n5}${n6}0000${n7}`;
  const body = `${ns}${mid}`; // 11 digits → check digit makes UPC-A
  if (body.length !== 11) return null;
  return body + checkDigit(body);
}

/**
 * @returns {{
 *   ok: boolean,
 *   input: string,
 *   gtin14: string | null,
 *   upcA: string | null,
 *   ean13: string | null,
 *   issue: string | null,
 * }}
 */
export function normalizeGtin(raw) {
  const input = String(raw ?? "").trim();
  let d = digitsOnly(input);
  if (!d) return { ok: false, input, gtin14: null, upcA: null, ean13: null, issue: "empty" };

  if (d.length === 6 || d.length === 7 || (d.length === 8 && d[0] === "0")) {
    const upcA = expandUpcE(d);
    if (!upcA) return { ok: false, input, gtin14: null, upcA: null, ean13: null, issue: "bad upc-e" };
    d = upcA;
  }

  if (d.length === 11) d = `0${d}`;
  if (d.length === 12 || d.length === 13 || d.length === 14) {
    const issue = gtinIssue(d);
    if (issue) return { ok: false, input, gtin14: null, upcA: null, ean13: null, issue };
    const gtin14 = d.padStart(14, "0");
    const upcA = gtin14.slice(2); // last 12
    const ean13 = gtin14.slice(1); // last 13
    return { ok: true, input, gtin14, upcA, ean13, issue: null };
  }

  return { ok: false, input, gtin14: null, upcA: null, ean13: null, issue: `unsupported length ${d.length}` };
}

/**
 * Every stored form a scan might equal: UPC-A, EAN-13, GTIN-14, UPC-E expanded,
 * an 11-digit code with the leading zero put back, and a zero-padded Costco item label.
 * Costco 4999 codes stay as themselves. They are not manufacturer GTINs.
 */
export function barcodeLookupKeys(raw) {
  const keys = new Set();
  const add = (value) => {
    const digits = digitsOnly(value);
    if (/^\d{4,14}$/.test(digits)) keys.add(digits);
  };
  const d = digitsOnly(raw);
  if (!d) return [];
  add(d);
  if (isCostcoInternalCode(d)) return [...keys];

  if (d.length === 6 || d.length === 7 || (d.length === 8 && d[0] === "0")) {
    const upcA = expandUpcE(d);
    if (upcA && !gtinIssue(upcA)) add(upcA);
  }

  let code = d;
  if (code.length === 11) {
    const padded = `0${code}`;
    if (!gtinIssue(padded)) code = padded;
  }
  if ((code.length === 12 || code.length === 13 || code.length === 14) && !gtinIssue(code)) {
    const gtin14 = code.padStart(14, "0");
    add(gtin14);
    add(gtin14.slice(1));
    add(gtin14.slice(2));
    // Warehouse labels print the Costco item number with leading zeros and a check digit.
    if (/^0{3,}/.test(code)) {
      const item = code.slice(0, -1).replace(/^0+/, "");
      if (item.length >= 4 && item.length <= 10) add(item);
    }
  }
  if (d.length === 12 && d.startsWith("0")) add(d.slice(1));
  return [...keys];
}
