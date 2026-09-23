/** ticket_extras.card_cents already includes the card fee. */
export function manualRefundMessage(method: string, cardCents: number, cashCents: number): string {
  if (![cardCents, cashCents].every(n => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error("Cannot determine refund amounts. Check the ticket before voiding.");
  }
  const money = (n: number) => `$${(n / 100).toFixed(2)}`;
  if (method === "card" || method === "split") {
    return `Ticket voided. Refund ${money(cardCents)} in the Square app.${method === "split" ? ` Return ${money(cashCents)} cash from the drawer.` : ""}`;
  }
  return "Ticket voided.";
}
