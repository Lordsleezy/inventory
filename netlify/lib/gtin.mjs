export function gtinIssue(value) {
  const code = String(value ?? "").trim();
  if (!code) return null;
  if (!/^\d+$/.test(code)) return "digits only";
  if (![12, 13, 14].includes(code.length)) return "must have 12, 13, or 14 digits";
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(code[i]) * weight;
  }
  return Number(code.at(-1)) === (10 - sum % 10) % 10 ? null : "bad check digit";
}
