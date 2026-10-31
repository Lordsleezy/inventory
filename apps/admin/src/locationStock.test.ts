import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignedTotal,
  formatLocationSummary,
  singleBinOrUnassigned,
  unassignedQty,
} from './locationStock.ts';

describe('locationStock helpers', () => {
  it('summarizes split stock', () => {
    const text = formatLocationSummary(17, [
      { location_code: '1-2-1', quantity: 12 },
      { location_code: '4-1-2', quantity: 5 },
    ]);
    assert.equal(text, '12 at 1-2-1 · 5 at 4-1-2');
  });

  it('includes unassigned pieces', () => {
    assert.equal(unassignedQty(10, [{ location_code: '2-1-1', quantity: 7 }]), 3);
    assert.equal(formatLocationSummary(10, [{ location_code: '2-1-1', quantity: 7 }]), '7 at 2-1-1 · 3 unassigned');
  });

  it('detects simple editor mode', () => {
    assert.equal(singleBinOrUnassigned([], 1), true);
    assert.equal(singleBinOrUnassigned([{ location_code: '1-1-1', quantity: 1 }], 1), true);
    assert.equal(singleBinOrUnassigned([{ location_code: '1-1-1', quantity: 2 }, { location_code: '2-2-2', quantity: 3 }], 5), false);
    assert.equal(assignedTotal([{ location_code: '1-1-1', quantity: 4 }]), 4);
  });
});
