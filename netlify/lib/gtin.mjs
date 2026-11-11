/** Costco item numbers on B-Stock manifests. Not a manufacturer GTIN. */
export function isCostcoInternalCode(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return /^4999\d{4,10}$/.test(digits);
}

/** Digits safe to send to Amazon, TikTok, or eBay. A 4999 code is never a GTIN. */
export function marketplaceGtin(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits || isCostcoInternalCode(digits) || gtinIssue(digits)) return "";
  return digits;
}

export function gtinIssue(value) {
  const code = String(value ?? "").trim();
  if (!code) return null;
  if (isCostcoInternalCode(code)) return "costco internal item number";
  if (!/^\d+$/.test(code)) return "digits only";
  if (![12, 13, 14].includes(code.length)) return "must have 12, 13, or 14 digits";
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(code[i]) * weight;
  }
  return Number(code.at(-1)) === (10 - sum % 10) % 10 ? null : "bad check digit";
}
