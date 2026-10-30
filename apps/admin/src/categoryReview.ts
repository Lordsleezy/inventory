export type CategoryReviewInput = {
  category_id?: string | null;
  review_reason?: string | null;
  category_issues?: string[];
  auto_picked?: boolean;
  missing?: string[];
  item?: { condition?: string };
};

export type CategoryReviewAction = 'confirm' | 'condition' | 'specifics' | 'category';
export type CategoryReview = { message: string; action: CategoryReviewAction };

/** Translate the stored eBay category blocker into the field the owner can fix. */
export function categoryReview(input: CategoryReviewInput | null): CategoryReview | null {
  if (!input?.category_id) return null;
  const reason = String(input.review_reason || input.category_issues?.find(x => !/^(missing required field|channel document required)$/i.test(x)) || '').trim();
  const missing = input.missing || [];
  const condition = String(input.item?.condition || '').trim();
  if (/condition/i.test(reason) || missing.some(x => /^condition$/i.test(x))) {
    return { message: `Condition${condition ? ` “${condition}”` : ''} is not accepted for this eBay category. Choose an allowed condition before listing.`, action: 'condition' };
  }
  const specifics = missing.filter(x => !/^condition$/i.test(x));
  if (specifics.length) return { message: `Required eBay item specifics are missing: ${specifics.join(', ')}. Fill them in below.`, action: 'specifics' };
  if (/conflict/i.test(reason)) return { message: 'Floor found conflicting category sources while checking sales channels. Check the selected eBay category and confirm it if it is right.', action: 'confirm' };
  if (/unsynced|not synced|fields|stale|changed|retired|inactive|not active/i.test(reason)) {
    return { message: `This eBay category needs a fresh check: ${reason}. Re-select a current category.`, action: 'category' };
  }
  if (reason) return { message: `eBay category needs review: ${reason}. Check the category before confirming.`, action: 'confirm' };
  if (input.auto_picked) return { message: 'Floor selected this eBay category automatically. Confirm it if it is right.', action: 'confirm' };
  return null;
}
