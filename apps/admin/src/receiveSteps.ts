const ORDER: ReceiveStepId[] = ['confirm', 'photo', 'brand', 'title', 'category', 'condition', 'price', 'dims', 'stock', 'location', 'review'];

/** Move one screen. If the current screen dropped out because it just got filled, keep going in the same direction. */
export function adjacentReceiveStep(plan: ReceiveStepId[], current: ReceiveStepId, delta: 1 | -1): ReceiveStepId | null {
  const index = plan.indexOf(current);
  if (index >= 0) return plan[index + delta] || null;
  const from = ORDER.indexOf(current);
  if (from < 0) return null;
  const rest = delta > 0 ? ORDER.slice(from + 1) : ORDER.slice(0, from).reverse();
  return rest.find(id => plan.includes(id)) || null;
}

export type ReceiveStepId =
  | 'confirm'
  | 'photo'
  | 'brand'
  | 'title'
  | 'category'
  | 'condition'
  | 'price'
  | 'dims'
  | 'stock'
  | 'location'
  | 'review';

/** Screens after a confirmed identity. Photo, condition, and location always. Listing screens only when still empty, and never after Do not list. eBay category and item specifics are filled in the background and never get a screen. */
export function receiveStepPlan(input: {
  doNotList: boolean;
  brand: string;
  title: string;
  hasDims: boolean;
  hasStockMatch: boolean;
  /** New or Open box, and the manifest already has a retail price. */
  manifestPrice?: boolean;
}): ReceiveStepId[] {
  const steps: ReceiveStepId[] = ['confirm', 'photo'];
  if (!input.brand.trim()) steps.push('brand');
  if (!input.doNotList && !input.title.trim()) steps.push('title');
  steps.push('condition');
  if (!input.doNotList) {
    if (!input.manifestPrice) steps.push('price');
    if (!input.hasDims) steps.push('dims');
    if (input.hasStockMatch) steps.push('stock');
  }
  steps.push('location', 'review');
  return steps;
}
