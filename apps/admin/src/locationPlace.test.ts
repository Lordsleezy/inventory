import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addBulkSkus, bayTagCode, layoutBlocked, locationPhrase, parseBulkSkus, planPlaceInBin, planUnassign, unitsLabel } from './locationPlace.ts';

describe('location phrases', () => {
  it('reads a bin and a floor spot the way the bay screen does', () => {
    assert.equal(locationPhrase('1-1-1'), 'Bay 1 · Row 1 · Bin 1');
    assert.equal(locationPhrase('1-3'), 'Bay 1 · Row 3 · Floor');
    assert.equal(unitsLabel(1), '1 unit');
    assert.equal(unitsLabel(0), '0 units');
  });
});

describe('planPlaceInBin', () => {
  it('moves a unit that already sits in another bin instead of copying it', () => {
    assert.deepEqual(planPlaceInBin(1, [{ location_code: '2-1-1', quantity: 1 }], '1-1-1', 1), [
      { from: '2-1-1', to: '1-1-1', quantity: 1 },
    ]);
  });

  it('takes unassigned stock when nothing is shelved', () => {
    assert.deepEqual(planPlaceInBin(4, [], '1-1-1', 2), [
      { from: null, to: '1-1-1', quantity: 2 },
    ]);
  });

  it('empties other bins before drawing unassigned stock', () => {
    const moves = planPlaceInBin(8, [
      { location_code: '1-1-1', quantity: 1 },
      { location_code: '4-2-1', quantity: 2 },
    ], '1-1-1', 4);
    assert.deepEqual(moves, [
      { from: '4-2-1', to: '1-1-1', quantity: 2 },
      { from: null, to: '1-1-1', quantity: 2 },
    ]);
  });

  it('refuses a second copy of stock already in the bin', () => {
    assert.throws(
      () => planPlaceInBin(1, [{ location_code: '1-1-1', quantity: 1 }], '1-1-1', 1),
      /already in this bin/,
    );
  });
});

describe('planUnassign', () => {
  it('pulls the quantity off the bins that hold it', () => {
    assert.deepEqual(planUnassign([
      { location_code: '1-1-1', quantity: 2 },
      { location_code: '1-2-1', quantity: 3 },
    ], 4), [
      { from: '1-1-1', to: null, quantity: 2 },
      { from: '1-2-1', to: null, quantity: 2 },
    ]);
  });
});

describe('layoutBlocked', () => {
  it('stops a stocked bin from disappearing', () => {
    const message = layoutBlocked(1, [2], [
      { bay_no: 1, row_no: 1, bin_no: 3, code: '1-1-3', stock: 4 },
    ]);
    assert.match(message || '', /1-1-3/);
    assert.equal(layoutBlocked(1, [3], [
      { bay_no: 1, row_no: 1, bin_no: 3, code: '1-1-3', stock: 4 },
    ]), null);
  });
});

describe('bulk bay tag', () => {
  it('keeps unique SKUs from a pasted list', () => {
    assert.deepEqual(parseBulkSkus(' 99763\n99871, 99763 99874 '), ['99763', '99871', '99874']);
    assert.deepEqual(addBulkSkus(['99763'], '99871, 99763'), ['99763', '99871']);
  });

  it('tags into the first bin, or the floor when row 1 has no bins', () => {
    assert.equal(bayTagCode(4, [3, 2]), '4-1-1');
    assert.equal(bayTagCode(4, [0]), '4-1');
    assert.throws(() => bayTagCode(0, [1]), /Choose a bay/);
  });
});
