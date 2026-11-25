/** Format Jacob's home payout box. Keeps a real minus when he owes money back. */
export function formatPayoutDue(cents: number, money: (cents: number) => string): string {
  if (cents < 0) {
    const formatted = money(Math.abs(cents));
    return formatted.startsWith('-') ? formatted : `-${formatted.replace(/^-/, '')}`;
  }
  return money(cents);
}
