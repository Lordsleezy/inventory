import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAmazonAttributes } from './amazon-category-validation.mjs';

const schema = { type: 'object', properties: {
  condition_type: { type: 'array', items: { type: 'object', required: ['value'], properties: { value: { enum: ['new_new'] } } } },
  fulfillment_availability: { type: 'array', items: { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer', minimum: 0 } } } },
  merchant_shipping_group: { type: 'array', items: { type: 'object', required: ['value'], properties: { value: { enum: ['verified-template'] } } } },
}, allOf: [{ if: { required: ['fulfillment_availability'] }, then: { required: ['merchant_shipping_group'] } }] };

test('Amazon conditional shipping requirement is enforced even with no root required fields', () => {
  const errors = validateAmazonAttributes(schema, 'conditional-test', { fulfillment_availability: [{ quantity: 1 }] });
  assert(errors.some((error) => error.name === 'merchant_shipping_group'));
});
test('Amazon category condition enums and nested values are enforced', () => {
  const errors = validateAmazonAttributes(schema, 'conditional-test', {
    condition_type: [{ value: 'used_good' }], fulfillment_availability: [{}], merchant_shipping_group: [{ value: 'verified-template' }],
  });
  assert(errors.some((error) => error.name === 'condition_type'));
  assert(errors.some((error) => error.name === 'fulfillment_availability'));
});
test('A valid offer satisfies conditional rules', () => {
  assert.deepEqual(validateAmazonAttributes(schema, 'conditional-test', {
    condition_type: [{ value: 'new_new' }], fulfillment_availability: [{ quantity: 1 }],
    merchant_shipping_group: [{ value: 'verified-template' }],
  }), []);
});
