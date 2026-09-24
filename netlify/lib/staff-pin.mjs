export function clockLoginEmail(clock) {
  return `${String(clock).trim()}@staff.floor.local`;
}

export function authSecretFromLogin(identifier, secret) {
  const v = String(identifier || "").trim();
  if (v.includes("@")) return secret;
  return `floor${String(secret || "").trim()}`;
}

function isRepeatedDigits(pin) {
  return [...pin].every((ch) => ch === pin[0]);
}

function isStraightRun(pin) {
  const digits = [...pin].map((ch) => Number(ch));
  if (digits.length < 4) return false;
  const up = digits.every((n, i) => i === 0 || n === (digits[i - 1] + 1) % 10);
  const down = digits.every((n, i) => i === 0 || n === (digits[i - 1] + 9) % 10);
  return up || down;
}

export function clockRuleError(clock) {
  const v = String(clock || "").trim();
  if (!/^\d{4,8}$/.test(v)) return "Clock number must be 4–8 digits.";
  return null;
}

export function pinRuleError(pin, clock) {
  const v = String(pin || "").trim();
  if (!/^\d{4,8}$/.test(v)) return "PIN must be 4–8 digits. Letters and words are not allowed.";
  if (v === String(clock || "").trim()) return "PIN cannot be the same as the clock number.";
  if (isRepeatedDigits(v)) return "PIN cannot be all the same digit.";
  if (isStraightRun(v)) return "PIN cannot be a straight run like 1234 or 4321.";
  return null;
}
