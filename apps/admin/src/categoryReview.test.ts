import assert from 'node:assert/strict';
import test from 'node:test';
import { categoryReview } from './categoryReview.ts';

test('conflicting automatic category can be confirmed', () => {
  assert.deepEqual(categoryReview({ category_id: '158741', auto_picked: true, review_reason: 'conflicting category sources', missing: [] }), {
    message: 'Floor found conflicting category sources while checking sales channels. Check the selected eBay category and confirm it if it is right.', action: 'confirm',
  });
});

test('condition conflict points to Condition instead of clearing the category', () => {
  assert.equal(categoryReview({ category_id: '19258', review_reason: 'condition not allowed', item: { condition: 'Used - Good' } })?.action, 'condition');
  assert.match(categoryReview({ category_id: '19258', review_reason: 'condition not allowed', item: { condition: 'Used - Good' } })?.message || '', /Used - Good/);
});

test('required specifics point to specifics; stale taxonomy requires a category check', () => {
  assert.equal(categoryReview({ category_id: '19258', review_reason: 'conflicting category sources', missing: ['Brand'] })?.action, 'specifics');
  assert.equal(categoryReview({ category_id: '19258', review_reason: 'category taxonomy stale', missing: [] })?.action, 'category');
});

test('unconfirmed auto pick is confirmable and confirmed category has no prompt', () => {
  assert.equal(categoryReview({ category_id: '19258', auto_picked: true })?.action, 'confirm');
  assert.equal(categoryReview({ category_id: '19258', auto_picked: false }), null);
});
