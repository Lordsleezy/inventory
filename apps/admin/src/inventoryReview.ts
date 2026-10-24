export const REVIEW_LABELS: Record<string, string> = {
  review_hygiene: 'Verify unopened, unused hygiene contents',
  review_supplement: 'Supplement needs unopened packaging and expiration check',
  review_quantity: 'Confirm item count against photos',
  review_contents: 'Photograph and verify open-box contents',
  review_bundle: 'Resolve bundle link and verify contents',
  review_stove: 'Confirm stove compatibility',
  review_product: 'Correct product details and verify set contents',
  review_condition: 'Resolve eBay condition and category mismatch',
  review_cosmetic: 'Verify unused skincare and correct product title',
};

export function reviewReasonLabel(code: unknown): string | null {
  return REVIEW_LABELS[String(code || '')] || null;
}
