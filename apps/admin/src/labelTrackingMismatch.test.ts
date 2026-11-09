import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLabelMismatch } from './labelTrackingMismatch.ts';

test('parseLabelMismatch reads structured exception', () => {
  const p = parseLabelMismatch('label_mismatch|34608106244728542207|9434608106244728542207');
  assert.ok(p);
  assert.equal(p!.label, '34608106244728542207');
  assert.equal(p!.marketplaceGrouped, '9434 6081 0624 4728 5422 07');
});
