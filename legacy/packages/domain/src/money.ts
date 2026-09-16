/** Integer cents. Null means "not entered". Never treat null as zero. */
export type Cents = number;

export function moneyStringToCents(raw: string | number | null | undefined): Cents | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw).trim();
  if (!/^-?\d+(\.\d{1,4})?$/.test(s)) {
    throw new Error(`Invalid money value: ${raw}`);
  }
  const negative = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
  return negative ? -cents : cents;
}

export function centsToMoneyString(cents: Cents | null): string | null {
  if (cents === null) return null;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatUsd(cents: Cents | null): string {
  if (cents === null) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

export function discountOffRetail(
  askCents: Cents | null,
  retailCents: Cents | null,
): number | null {
  if (askCents === null || retailCents === null || retailCents === 0) return null;
  return Math.round(((retailCents - askCents) / retailCents) * 100);
}
