import test from 'node:test';
import assert from 'node:assert/strict';
import { googlePackageAttributes } from '../functions/google-sync.mjs';

test('Merchant API shipping attributes use the saved package dimensions and weight', () => {
  assert.deepEqual(googlePackageAttributes({ package_length_in: 12, package_width_in: 8, package_height_in: 4, package_weight_lb: 2.5 }), {
    shippingWeight: { value: 2.5, unit: 'lb' },
    shippingLength: { value: 12, unit: 'in' },
    shippingWidth: { value: 8, unit: 'in' },
    shippingHeight: { value: 4, unit: 'in' },
  });
});

test('Merchant API omits partial package dimensions instead of sending an incomplete set', () => {
  assert.deepEqual(googlePackageAttributes({ package_length_in: 12, package_width_in: null, package_height_in: 4, package_weight_lb: 2 }), {
    shippingWeight: { value: 2, unit: 'lb' },
  });
});
