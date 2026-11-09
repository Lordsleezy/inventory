import test from 'node:test';
import assert from 'node:assert/strict';
import { displayOrderTitle } from './orderDisplay.ts';

test('displayOrderTitle strips trailing pipe SKU suffix', () => {
  assert.equal(displayOrderTitle('Pura 5 Diffuser | SKU 99876'), 'Pura 5 Diffuser');
  assert.equal(displayOrderTitle('Widget | SKU99876'), 'Widget');
  assert.equal(displayOrderTitle('Widget | sku 12'), 'Widget');
});

test('displayOrderTitle leaves titles without suffix unchanged', () => {
  assert.equal(displayOrderTitle('ACHIM Buffalo Check Window Curtain Panel'), 'ACHIM Buffalo Check Window Curtain Panel');
  assert.equal(displayOrderTitle(''), 'Item');
});
