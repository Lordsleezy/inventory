import { reviewReasonLabel } from './inventoryReview';
const FIELD_LABELS: Record<string, string> = {
  title: 'title', brand: 'brand', model: 'model', category: 'category', category_review: 'eBay category review', specifics: 'eBay item specifics',
  price: 'price', condition: 'condition', photo: 'photo', spec: 'package size for shipping',
  upc: 'UPC', description: 'description',
};
export function inventoryMissingText(gaps: string[]): string {
  const fields = gaps.filter(g => !reviewReasonLabel(g)).map(g => FIELD_LABELS[g] || g);
  const reviews = gaps.map(reviewReasonLabel).filter(Boolean);
  return [fields.length ? `Missing: ${fields.join(', ')}` : '', ...reviews].filter(Boolean).join(' · ');
}
