import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDnsType } from './dns.ts';

test('oversized products go to DNS; accessories and air fryers do not', () => {
  for (const title of ['LG refrigerator', 'Fridge', 'Chest freezer', 'Deep fryer', 'Dishwasher', 'Queen mattress', 'Bed frame', 'Sectional sofa', 'Couch', 'Electric scooter']) {
    assert.equal(isDnsType({ title }), true, title);
  }
  for (const title of ['Refrigerator water filter', 'Mattress protector', 'Dishwasher hose', 'Air fryer', 'Sofa cushion']) {
    assert.equal(isDnsType({ title }), false, title);
  }
  assert.equal(isDnsType({ title: 'LG 27 cu ft', category: 'Refrigerators' }), true);
});
