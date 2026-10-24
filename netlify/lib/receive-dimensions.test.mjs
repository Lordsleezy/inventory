import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDimensions } from './receive-dimensions.mjs';

test('Floor values beat Amazon and UPCitemdb; missing carton fields are estimated', () => {
  const result = mergeDimensions(
    { product_width_in: undefined, aspects: { product_height_in: 8, product_width_in: 2 }, package_length_in: 11 },
    { item: { width_in: 3, length_in: 2, weight_lb: 0.7 }, package: { width_in: 4 } },
    { package: { width_in: 5 } },
  );
  assert.equal(result.values.product_height_in, 8);
  assert.equal(result.sources.product_height_in, 'Floor');
  assert.equal(result.values.package_length_in, 11);
  assert.equal(result.sources.package_length_in, 'Floor');
  assert.equal(result.values.package_width_in, 4);
  assert.equal(result.sources.package_width_in, 'Amazon');
  assert.equal(result.values.package_height_in, 10);
  assert.equal(result.sources.package_height_in, 'estimated');
  assert.equal(result.values.package_weight_lb, 0.8);
});

test('unknown measurements stay unknown', () => {
  const result = mergeDimensions(null, null, null);
  assert.equal(Object.values(result.values).every(value => value == null), true);
});
