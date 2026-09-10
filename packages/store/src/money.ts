/**
 * Money is integer cents, and blank is not zero.
 *
 * An empty price means nobody has decided what the thing is worth. That is a
 * different fact from "it is free", so it round-trips as null and renders as
 * an empty string — never as $0.00.
 */

/** Parse typed input. Returns null for blank, undefined for unparseable. */
export function parseMoneyToCents(input: string | null | undefined): number | null | undefined {
  if (input === null || input === undefined) return null;
  const text = String(input).trim().replace(/^\$/, "").replace(/,/g, "");
  if (text === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return undefined;
  const [whole, frac = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : undefined;
}

/** Bare number for input fields: 1999 -> "19.99", null -> "". */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const sign = cents < 0 ? "-" : "";
  const n = Math.abs(cents);
  return `${sign}${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
}

/** Display string: 1999 -> "$19.99", null -> "" (never "$0.00"). */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const sign = cents < 0 ? "-" : "";
  const n = Math.abs(cents);
  const whole = Math.floor(n / 100).toLocaleString("en-US");
  return `${sign}$${whole}.${String(n % 100).padStart(2, "0")}`;
}

/** Totals only. A real zero total is legitimately "$0.00". */
export function formatCentsTotal(cents: number): string {
  return formatCents(cents) || "$0.00";
}
