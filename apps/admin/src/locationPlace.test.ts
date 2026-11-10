import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addBulkSkus, bayTagCode, bayTitle, layoutBlocked, locationMenuLabel, locationPhrase, parseBulkSkus, planPlaceInBin, planUnassign, readBulkTagDraft, resolveLocationCode, skuMissingUpc, slotTagCode, sortLocationChoices, unitsLabel, upcScanKeys, upcToStore, writeBulkTagDraft } from './locationPlace.ts';

describe('location phrases', () => {
  it('reads a bin and a floor spot the way the bay screen does', () => {
    assert.equal(locationPhrase('1-1-1'), 'Bay 1 · Row 1 · Bin 1');
    assert.equal(locationPhrase('1-3'), 'Bay 1 · Row 3 · Floor');
    assert.equal(unitsLabel(1), '1 unit');
    assert.equal(unitsLabel(0), '0 units');
  });

  it('shows a named floor area as its name', () => {
    assert.equal(bayTitle(21, 'Rugs and Mats'), 'Rugs and Mats');
    assert.equal(bayTitle(4, '  '), 'Bay 4');
    assert.equal(locationMenuLabel({ code: '21-1', bay_no: 21, row_no: 1, bin_no: null, bay_name: 'Rugs and Mats' }), 'Rugs and Mats');
    assert.equal(locationMenuLabel({ code: '4-2-2', bay_no: 4, row_no: 2, bin_no: 2 }), 'Bay 4 · R2-B2');
    assert.equal(sortLocationChoices([
      { code: '2-1-1', bay_no: 2, row_no: 1, bin_no: 1 },
      { code: '21-1', bay_no: 21, row_no: 1, bin_no: null, bay_name: 'Rugs and Mats' },
    ])[0].code, '21-1');
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

  it('builds a code from the bay, row, and bin the menus picked', () => {
    assert.equal(slotTagCode(4, 2, 3, 2), '4-2-2');
    assert.equal(slotTagCode(4, 3, 0, null), '4-3');
    assert.throws(() => slotTagCode(4, 2, 3, null), /Choose a bin/);
  });
});

describe('upc scan into a location', () => {
  const upc = '036000291452';

  it('leaves a short SKU alone', () => {
    assert.deepEqual(upcScanKeys('11921'), []);
    assert.deepEqual(resolveLocationCode('11921', []), { action: 'miss', upc: false });
  });

  it('uses the only SKU on that UPC, including the leading-zero form', () => {
    assert.deepEqual(resolveLocationCode(upc, [
      { sku: '11921', title: 'Cereal', upc: '0036000291452' },
    ]), { action: 'use', sku: '11921' });
  });

  it('asks which SKU when the UPC is on more than one', () => {
    const result = resolveLocationCode(upc, [
      { sku: '200', title: 'Second', upc },
      { sku: '100', title: 'First', upc },
    ]);
    assert.equal(result.action, 'pick');
    if (result.action === 'pick') assert.deepEqual(result.choices.map((row) => row.sku), ['100', '200']);
  });

  it('keeps an exact SKU when those digits are also a UPC', () => {
    assert.deepEqual(resolveLocationCode(upc, [
      { sku: upc, title: 'The SKU itself', upc: null },
      { sku: '11921', title: 'Other', upc },
    ]), { action: 'use', sku: upc });
  });
});

describe('bulk tag draft', () => {
  const draft = { draft: '119', bay: '4', row: '2', bin: '3', skus: ['11921', '11944'], ask: null as null };
  const blank = { session: null, local: null, sessionLive: false };

  it('keeps the list for this session and for a reload that still has the session', () => {
    const saved = writeBulkTagDraft(blank, draft);
    assert.equal(saved.sessionLive, true);
    assert.deepEqual(readBulkTagDraft({ ...blank, session: saved.session }), draft);
    assert.deepEqual(readBulkTagDraft({ ...blank, sessionLive: true, local: saved.local }), draft);
  });

  it('drops a leftover list after the app session is gone', () => {
    const saved = writeBulkTagDraft(blank, draft);
    assert.equal(readBulkTagDraft({ ...blank, local: saved.local, sessionLive: false }), null);
  });

  it('clears both copies when the form is empty', () => {
    const saved = writeBulkTagDraft(blank, draft);
    assert.deepEqual(writeBulkTagDraft(saved, { draft: '  ', bay: '', row: '1', bin: '1', skus: [], ask: null }), {
      session: null,
      local: null,
      sessionLive: true,
    });
  });

  it('keeps an open UPC prompt with whatever was already scanned into it', () => {
    const asking = { ...draft, draft: '', skus: ['11944'], ask: { sku: '11921', title: 'Cereal', value: '036000' } };
    const saved = writeBulkTagDraft(blank, asking);
    assert.deepEqual(readBulkTagDraft({ ...blank, session: saved.session }), asking);
  });
});

describe('sku missing a upc', () => {
  const cereal = { sku: '11921', title: 'Cereal', upc: null };

  it('asks when the typed SKU has no barcode', () => {
    assert.deepEqual(skuMissingUpc('11921', [cereal]), { sku: '11921', title: 'Cereal' });
  });

  it('stays quiet when the SKU already has a UPC or the scan was a UPC', () => {
    assert.equal(skuMissingUpc('11921', [{ ...cereal, upc: '036000291452' }]), null);
    assert.equal(skuMissingUpc('036000291452', [cereal]), null);
    assert.equal(skuMissingUpc('11921', []), null);
  });

  it('stores a scanned UPC and rejects a bad one', () => {
    assert.deepEqual(upcToStore('036000291452'), { ok: true, upc: '036000291452' });
    assert.equal(upcToStore('123').ok, false);
  });
});
