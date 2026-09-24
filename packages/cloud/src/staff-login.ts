export const STAFF_CLOCK_DOMAIN = "staff.floor.local";

export function clockLoginEmail(clock: string): string {
  return `${clock.trim()}@${STAFF_CLOCK_DOMAIN}`;
}

export function authSecretFromLogin(identifier: string, secret: string): string {
  const v = identifier.trim();
  if (v.includes("@")) return secret;
  return `floor${secret.trim()}`;
}

export function loginEmailFromIdentifier(raw: string): string {
  const v = raw.trim();
  if (v.includes("@")) return v.toLowerCase();
  return clockLoginEmail(v);
}

export function clockRuleError(clock: string): string | null {
  const v = clock.trim();
  if (!/^\d{4,8}$/.test(v)) return "Clock number must be 4–8 digits.";
  return null;
}

function isRepeatedDigits(pin: string): boolean {
  return pin.split("").every((ch) => ch === pin[0]);
}

function isStraightRun(pin: string): boolean {
  const digits = [...pin].map((ch) => Number(ch));
  if (digits.length < 4) return false;
  const up = digits.every((n, i) => i === 0 || n === (digits[i - 1] + 1) % 10);
  const down = digits.every((n, i) => i === 0 || n === (digits[i - 1] + 9) % 10);
  return up || down;
}

export function pinRuleError(pin: string, clock: string): string | null {
  const v = pin.trim();
  if (!/^\d{4,8}$/.test(v)) {
    return "PIN must be 4–8 digits. Letters and words are not allowed.";
  }
  if (v === clock.trim()) return "PIN cannot be the same as the clock number.";
  if (isRepeatedDigits(v)) return "PIN cannot be all the same digit.";
  if (isStraightRun(v)) return "PIN cannot be a straight run like 1234 or 4321.";
  return null;
}
