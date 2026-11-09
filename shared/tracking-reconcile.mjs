import { uspsCheckDigitValid, completeUspsFromBody, digitsOnly } from "./tracking-validate.mjs";
import { compactTracking } from "./tracking-normalize.mjs";

/** @param {string} a @param {string} b */
export function trackingNumbersEquivalent(a, b) {
  const A = compactTracking(a);
  const B = compactTracking(b);
  if (!A || !B) return false;
  if (A === B) return true;
  const long = A.length >= B.length ? A : B;
  const short = A.length < B.length ? A : B;
  if (long.endsWith(short) && uspsCheckDigitValid(long)) return true;
  const fixed = completeUspsFromBody(short);
  if (fixed && (fixed === long || long.endsWith(fixed))) return true;
  return false;
}

export function formatUspsGroups(number) {
  const d = digitsOnly(number);
  if (d.length < 12) return d;
  const parts = [];
  for (let i = 0; i < d.length; i += 4) parts.push(d.slice(i, i + 4));
  return parts.join(" ");
}

export { completeUspsFromBody };
