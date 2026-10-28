import test from 'node:test';
import assert from 'node:assert/strict';
import { isCompleteReceiveTitle, isStoreLabelBarcode } from '../../shared/store-barcode.mjs';

test('recognizes known retailer-label barcode patterns', () => {
  assert.equal(isStoreLabelBarcode('490680352443'), true);
  assert.equal(isStoreLabelBarcode('200123456789'), true);
  assert.equal(isStoreLabelBarcode('054006628959'), false);
});

test('only accepts complete, branded photo-identification titles', () => {
  assert.equal(isCompleteReceiveTitle('ACHIM Buffalo Check Window Curtain Panel, 42 x 84 in, Sage/Cream', 'ACHIM'), true);
  assert.equal(isCompleteReceiveTitle('ACHIM Rustic', 'ACHIM'), false);
  assert.equal(isCompleteReceiveTitle('Threshold Linen Curtain Panel 54 x 84 in Cream', 'ACHIM'), false);
});
