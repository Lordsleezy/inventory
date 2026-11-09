/** Carrier format checks and check digits for label tracking extraction. */

export function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

export function alphaNumOnly(value) {
  return String(value || "").replace(/[^0-9A-Z]/gi, "").toUpperCase();
}

/** Pitney Bowes / permit imprints — not the package tracking number. */
export function isPostagePermitId(value) {
  const s = String(value || "").toUpperCase();
  return /^0\d{2}W\d{10,}$/.test(s) || /^[A-Z]{3}\d{10,}$/.test(s);
}

export function isLikelySkuLine(text) {
  return /\bSKU\s*:\s*\d+/i.test(text);
}

/** USPS 20- or 22-digit IMpb-style numbers starting with 91–95. */
export function uspsCheckDigitValid(number) {
  const d = digitsOnly(number);
  if (!/^(9[1-5]\d{17,21})$/.test(d)) return false;
  const digits = d.split("").map(Number);
  let sum = 0;
  for (let i = digits.length - 2; i >= 0; i -= 1) {
    const fromRight = digits.length - 2 - i;
    sum += digits[i] * (fromRight % 2 === 0 ? 3 : 1);
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === digits[digits.length - 1];
}

const UPS_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function ups1ZValid(value) {
  const s = alphaNumOnly(value);
  const m = s.match(/^1Z[A-Z0-9]{16}$/);
  if (!m) return false;
  const chars = m[0].split("");
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const ch = chars[i];
    let v = Number(ch);
    if (Number.isNaN(v)) v = UPS_ALPHA.indexOf(ch) + 1;
    if (v < 0) return false;
    const weight = i % 2 === 0 ? 2 : 1;
    v *= weight;
    sum += Math.floor(v / 10) + (v % 10);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(chars[17]);
}

const USPS_PREFIXES = ["91", "92", "93", "94", "95"];

/** Turn an 18–20 digit body missing the leading 91–95 into a valid USPS number when possible. */
export function completeUspsFromBody(digits) {
  const d = digitsOnly(digits);
  if (!d || d.length < 18 || d.length > 20) return null;
  if (/^9[2-5]\d{18,24}$/.test(d) && uspsCheckDigitValid(d)) return d;
  const out = [];
  for (const prefix of USPS_PREFIXES) {
    const full = `${prefix}${d}`;
    if (full.length >= 20 && full.length <= 22 && uspsCheckDigitValid(full)) out.push(full);
  }
  if (!out.length) return null;
  out.sort((a, b) => b.length - a.length);
  return out[0];
}

/** Common FedEx door-tag / tracking lengths — mod 11 on 15-digit subset when applicable. */
export function fedExValid(value) {
  const d = digitsOnly(value);
  if (!/^\d{12}$|^\d{15}$|^\d{20}$|^\d{22}$/.test(d)) return false;
  if (/^9[2-5]/.test(d) && d.length >= 20) return false;
  if ((d.length === 18 || d.length === 20) && completeUspsFromBody(d)) return false;
  if (d.length === 15) {
    let sum = 0;
    for (let i = 0; i < 14; i += 1) {
      sum += Number(d[i]) * (i % 2 === 0 ? 3 : 1);
    }
    const mod = sum % 11;
    const check = mod === 0 ? 0 : 11 - mod;
    if (check === 10) return d[14] === "0";
    if (check === 11) return d[14] === "0";
    return check === Number(d[14]);
  }
  if (d.length === 12 || d.length === 20 || d.length === 22) return true;
  return false;
}

export function classifyCarrier(number) {
  const s = alphaNumOnly(number);
  if (/^1Z[0-9A-Z]{16}$/.test(s) && ups1ZValid(s)) return "UPS";
  const d = digitsOnly(s);
  if (/^9[2-5]\d{18,24}$/.test(d) && uspsCheckDigitValid(d)) return "USPS";
  if (fedExValid(d)) return "FedEx";
  if (/^1Z/.test(s)) return "UPS";
  if (/^9[2-5]/.test(d)) return "USPS";
  return null;
}

export function validateTrackingCandidate(number, { nearTrackingLabel = false } = {}) {
  const compact = alphaNumOnly(number);
  const usps = digitsOnly(compact);
  if (isPostagePermitId(compact)) return null;
  if (compact.length < 10) return null;

  if (/^1Z[0-9A-Z]{16}$/i.test(compact)) {
    const ok = ups1ZValid(compact);
    if (!ok && !nearTrackingLabel) return null;
    return { number: compact, carrier: "UPS", score: (ok ? 6 : 3) + (nearTrackingLabel ? 8 : 0) };
  }
  if (/^9[2-5]\d{18,24}$/.test(usps)) {
    if (!uspsCheckDigitValid(usps)) return null;
    return { number: usps, carrier: "USPS", score: 4 + (nearTrackingLabel ? 10 : 0) };
  }
  const completed = completeUspsFromBody(usps);
  if (completed) {
    return { number: completed, carrier: "USPS", score: 5 + (nearTrackingLabel ? 11 : 0) };
  }
  if (/^\d{12}$|^\d{15}$|^\d{20}$/.test(usps) && fedExValid(usps)) {
    return { number: usps, carrier: "FedEx", score: 2 + (nearTrackingLabel ? 6 : 0) };
  }
  return null;
}
