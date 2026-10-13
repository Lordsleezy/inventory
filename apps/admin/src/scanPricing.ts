/** Category default acquisition costs (cents) — same as Floor Amazon / payout defaults. */
export function categoryDefaultCostCents(input: {
  title?: string | null;
  brand?: string | null;
  model?: string | null;
  category?: string | null;
  isCollectible?: boolean;
}): { cents: number; label: string } {
  if (input.isCollectible) return { cents: 0, label: 'collectible ($0)' };
  const blob = `${input.category || ''} ${input.title || ''} ${input.brand || ''} ${input.model || ''}`.toLowerCase();
  if (/fridge|refrigerator|dishwasher/.test(blob)) return { cents: 25000, label: 'fridge/dishwasher default ($250)' };
  if (/mattress|box.?spring/.test(blob)) return { cents: 30000, label: 'mattress default ($300)' };
  if (/collectible|trading.?card|funko|pokemon card/.test(blob)) return { cents: 0, label: 'collectible ($0)' };
  return { cents: 900, label: 'general default ($9)' };
}

/** Rough label estimate from weight (buyer-pays ship; used in fee-on-shipping floor math). */
export function estimateShipLabelCents(weightLb: number | null | undefined): number {
  const w = Number(weightLb);
  if (!Number.isFinite(w) || w <= 0) return 900;
  if (w <= 1) return 599;
  if (w <= 3) return 899;
  if (w <= 10) return 1299;
  if (w <= 20) return 1899;
  return 2499;
}

const EBAY_RATE = 0.136;
const EBAY_FIXED_CENTS = 40;
const PACKING_CENTS = 200;
const MIN_PROFIT_CENTS = 500;

export type PriceFloor = {
  floorCents: number;
  costCents: number;
  shipCents: number;
  packingCents: number;
  feeCents: number;
  profitCents: number;
  costIsEstimate: boolean;
  costLabel: string;
  mathLine: string;
};

/**
 * Listing-pipeline floor: list price so store nets ≥ cost + $5 after marketplace fees,
 * packing, and fee-on-buyer-shipping (same idea as vendoo `storePrice(cost+5, ebayFee, …)`).
 */
export function priceFloorCents(opts: {
  costCents: number | null;
  weightLb?: number | null;
  title?: string | null;
  brand?: string | null;
  model?: string | null;
  category?: string | null;
  isCollectible?: boolean;
}): PriceFloor {
  const def = categoryDefaultCostCents(opts);
  const costIsEstimate = opts.costCents == null || !Number.isFinite(opts.costCents);
  const costCents = costIsEstimate ? def.cents : Math.max(0, Math.round(opts.costCents!));
  const shipCents = estimateShipLabelCents(opts.weightLb);
  const netNeeded = costCents + MIN_PROFIT_CENTS; // cost + $5
  // Buyer pays label; fee still applies to shipping → shippingInNumerator = rate * label
  const shippingInNumerator = Math.round(EBAY_RATE * shipCents);
  const gross =
    (netNeeded + PACKING_CENTS + shippingInNumerator + EBAY_FIXED_CENTS) / (1 - EBAY_RATE);
  const floorCents = Math.max(599, Math.ceil(gross));
  const feeCents = Math.round(floorCents * EBAY_RATE) + EBAY_FIXED_CENTS;
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  return {
    floorCents,
    costCents,
    shipCents,
    packingCents: PACKING_CENTS,
    feeCents,
    profitCents: MIN_PROFIT_CENTS,
    costIsEstimate,
    costLabel: costIsEstimate ? def.label : 'entered cost',
    mathLine: `Floor ${money(floorCents)} = ${costIsEstimate ? def.label : money(costCents)} + fees ~${money(feeCents)} + ship fee-on-label ~${money(shippingInNumerator)} + packing ${money(PACKING_CENTS)} + $5 profit (grossed up for ${Math.round(EBAY_RATE * 1000) / 10}% marketplace fee)`,
  };
}

/**
 * ≈55% of retail, ending in .99, never at/over retail, never under the fee+ship+$5 floor.
 */
export function suggestAskCents(retailCents: number | null, floor: PriceFloor): number | null {
  if (retailCents == null || !(retailCents > 0)) return null;
  let price = Math.ceil((Math.round(retailCents * 0.55) + 1) / 100) * 100 - 1;
  price = Math.max(price, floor.floorCents, 599);
  if (price >= retailCents) price = retailCents - 1;
  return price > 0 ? price : null;
}
