import test from 'node:test';
import assert from 'node:assert/strict';
import { derivativePath, isStockPhoto, listThumbPhoto, orderScreenPhotos, photoKind } from './unitPhotos.ts';

const rows = [
  { id: 2, source: 'stock', sort_order: 0, path: 's' },
  { id: 4, source: 'camera', sort_order: 2, path: 'c2' },
  { id: 3, source: 'camera', sort_order: 1, path: 'c1' },
  { id: 5, source: 'stock', sort_order: 1, is_primary: true, path: 's2' },
];

test('order screen leads with real photos and leaves the source list alone', () => {
  const before = rows.map((row) => row.id);
  assert.deepEqual(orderScreenPhotos(rows).map((row) => row.id), [3, 4, 2, 5]);
  assert.deepEqual(rows.map((row) => row.id), before);
  assert.equal(listThumbPhoto(rows)?.id, 3);
});

test('stock photos are the manufacturer shots; camera and other sources are the unit', () => {
  assert.equal(isStockPhoto({ source: 'stock' }), true);
  assert.equal(isStockPhoto({ source: 'camera' }), false);
  assert.equal(isStockPhoto({ source: null }), false);
  assert.equal(photoKind({ source: 'stock' }), 'Stock photo');
  assert.equal(photoKind({ source: 'camera' }), 'Real photo');
});

test('thumbnail and detail keys stay on the web derivatives, not the original file', () => {
  const original = '5487ca47-6147-4fe8-bc6d-46b6472726ba/99903/curtain.jpg';
  assert.equal(derivativePath(original, 400), '5487ca47-6147-4fe8-bc6d-46b6472726ba/99903/web/400/curtain.webp');
  assert.equal(derivativePath(original, 1200), '5487ca47-6147-4fe8-bc6d-46b6472726ba/99903/web/1200/curtain.webp');
  assert.equal(derivativePath('archive/nope.jpg', 400), null);
});
