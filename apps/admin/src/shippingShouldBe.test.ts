import test from 'node:test';
import assert from 'node:assert/strict';
import {
  billedPounds,
  buyerShipCents,
  classifyShip,
  packageWrite,
  shouldBeShipCents,
} from '../../../shared/shipping-should-be.mjs';

test('dimensional weight applies to a big box and a tiny item stays on the $6 floor', () => {
  const big = billedPounds({ weight_lb: 2, length_in: 30, width_in: 20, height_in: 10 });
  assert.ok(big > 30);
  const tiny = shouldBeShipCents({ weight_lb: 0.2, length_in: 6, width_in: 4, height_in: 2 });
  assert.equal(tiny, buyerShipCents(650));
  assert.equal(buyerShipCents(100), buyerShipCents(600));
  assert.ok(tiny < 800);
});

test('a higher eBay price can be corrected and a lower one is never raised', () => {
  const floor = { weight_lb: 2, length_in: 10, width_in: 8, height_in: 4 };
  const should = shouldBeShipCents(floor) ?? 0;
  assert.equal(classifyShip(should + 200, should), 'too_high');
  assert.equal(classifyShip(should - 200, should), 'too_low');
  assert.equal(classifyShip(should + 50, should), 'fine');
  const high = packageWrite(
    { weight_lb: 20, length_in: 24, width_in: 18, height_in: 12 },
    floor,
    4000,
  );
  assert.equal(high.write, true);
  const low = packageWrite(floor, { weight_lb: 20, length_in: 24, width_in: 18, height_in: 12 }, 700);
  assert.equal(low.write, false);
  assert.equal(low.reason, 'too_low');
});

test('a matching package and a non-shipping field are left alone', () => {
  const floor = { weight_lb: 4, length_in: 12, width_in: 9, height_in: 3 };
  const same = packageWrite(
    { weight_lb: 4, length_in: 12, width_in: 9, height_in: 3 },
    floor,
    2000,
  );
  assert.equal(same.write, false);
  assert.equal(same.reason, 'already_matches');
  const tiny = packageWrite(
    { weight_lb: 2, length_in: 12, width_in: 9, height_in: 4 },
    { weight_lb: 0.05, length_in: 12, width_in: 12, height_in: 3 },
    2500,
  );
  assert.equal(tiny.write, false);
  assert.equal(tiny.reason, 'weight_unusable');
  const original = { title: 'Dryer', price: '19.99', weight_lb: 8, length_in: 36, width_in: 28, height_in: 3 };
  const decision = packageWrite(original, { weight_lb: 2, length_in: 12, width_in: 8, height_in: 6 }, 2500);
  assert.equal(decision.write, true);
  assert.equal(original.title, 'Dryer');
  assert.equal(original.price, '19.99');
});
