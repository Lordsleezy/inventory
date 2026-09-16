import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const PIN_PATTERN = /^\d{4,8}$/;

export function isPin(value: string): boolean {
  return PIN_PATTERN.test(value);
}

export function hashPin(pin: string): string {
  if (!isPin(pin)) throw new Error("PIN must be 4–8 digits");
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const check = scryptSync(pin, salt, 32);
  const expected = Buffer.from(hash, "hex");
  if (check.length !== expected.length) return false;
  return timingSafeEqual(check, expected);
}

/** Strong password for InvenTree / Django. Never the PIN. */
export function generateInventreePassword(): string {
  return `${randomBytes(24).toString("base64url")}Aa1!`;
}
