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

/** Screens after a confirmed identity. Photo, condition, and location always. Listing screens only when still empty, and never after Do not list. */
export function receiveStepPlan(input: {
  doNotList: boolean;
  brand: string;
  title: string;
  hasCategory: boolean;
  needsSpecifics: boolean;
  hasDims: boolean;
  hasStockMatch: boolean;
}): ReceiveStepId[] {
  const steps: ReceiveStepId[] = ['confirm', 'photo'];
  if (!input.brand.trim()) steps.push('brand');
  if (!input.doNotList && !input.title.trim()) steps.push('title');
  if (!input.doNotList && (!input.hasCategory || input.needsSpecifics)) steps.push('category');
  steps.push('condition');
  if (!input.doNotList) {
    steps.push('price');
    if (!input.hasDims) steps.push('dims');
    if (input.hasStockMatch) steps.push('stock');
  }
  steps.push('location', 'review');
  return steps;
}
