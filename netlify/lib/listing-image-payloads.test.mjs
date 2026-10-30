import assert from 'node:assert/strict';
import test from 'node:test';
import { amazonImageLocatorPatches, orderedListingImages, tiktokMainImagePayload } from './listing-image-payloads.mjs';

test('marketplace photos keep stock first, retain a real unit photo, dedupe and honor channel limit', () => {
  assert.deepEqual(orderedListingImages(['https://stock/1', 'https://stock/2'],
    ['https://unit/1', 'https://unit/2'], 3), ['https://stock/1', 'https://stock/2', 'https://unit/1']);
  assert.deepEqual(orderedListingImages(['https://stock/1'], ['https://stock/1', 'https://unit/1']),
    ['https://stock/1', 'https://unit/1']);
  assert.throws(() => orderedListingImages(['https://stock/1'], []), /actual_unit_photo_required/);
});

test('Amazon photo patch replaces ordered slots and deletes stale trailing slots', () => {
  const patches = amazonImageLocatorPatches(['https://stock/1', 'https://unit/1'], 'ATVPDKIKX0DER');
  assert.equal(patches.length, 9);
  assert.equal(patches[0].path, '/attributes/main_product_image_locator');
  assert.equal(patches[0].value[0].media_location, 'https://stock/1');
  assert.equal(patches[1].value[0].media_location, 'https://unit/1');
  assert.equal(patches[2].op, 'delete');
});

test('TikTok product image payload preserves order and caps at nine', () => {
  assert.deepEqual(tiktokMainImagePayload(['first', '', 'second']), [{ uri: 'first' }, { uri: 'second' }]);
});
