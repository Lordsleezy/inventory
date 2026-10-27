import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickerOptions, rankedOptions, valueIsValid, type AspectDef } from './aspectOptions.ts';

const DEPT: AspectDef = { name: 'Department', required: true, allowed: ['Men', 'Women', 'Unisex Adults'], selection_only: true };
const COLOR: AspectDef = { name: 'Frame Color', required: true, allowed: ['Black', 'Brown', 'Blue'], selection_only: false };

test('tapping a box (no typing) lists eBay\'s allowed values', () => {
  assert.deepEqual(pickerOptions(DEPT, [], '').options, ['Men', 'Women', 'Unisex Adults']);
  assert.deepEqual(pickerOptions(COLOR, [], '').options, ['Black', 'Brown', 'Blue']);
});

test('the values used most in Floor are listed first', () => {
  assert.deepEqual(pickerOptions(COLOR, ['Brown'], '').options, ['Brown', 'Black', 'Blue']);
  assert.deepEqual(rankedOptions(DEPT, ['Ladies', 'Women']), ['Women', 'Men', 'Unisex Adults'], 'a list-only aspect never offers a value outside eBay\'s list');
});

test('typing filters the list live', () => {
  assert.deepEqual(pickerOptions(COLOR, [], 'bl').options, ['Black', 'Blue']);
  assert.deepEqual(pickerOptions(DEPT, [], 'wom').options, ['Women']);
});

test('free-text aspects offer "Use <typed>"; list-only aspects never do', () => {
  assert.equal(pickerOptions(COLOR, [], 'Tortoise').typed, 'Tortoise');
  assert.equal(pickerOptions(COLOR, [], 'black').typed, null, 'an exact match is just selected');
  assert.equal(pickerOptions(DEPT, [], 'Ladies').typed, null);
  assert.deepEqual(pickerOptions(DEPT, [], 'Ladies').options, []);
});

test('huge lists show the first page and say how many more', () => {
  const big: AspectDef = { name: 'Brand', allowed: Array.from({ length: 500 }, (_, i) => `Brand ${i}`) };
  const r = pickerOptions(big, [], '');
  assert.equal(r.options.length, 60);
  assert.equal(r.more, 440);
});

test('validity matches what eBay allows', () => {
  assert.equal(valueIsValid(DEPT, 'Women'), true);
  assert.equal(valueIsValid(DEPT, 'Ladies'), false);
  assert.equal(valueIsValid(COLOR, 'Tortoise'), true);
  assert.equal(valueIsValid(COLOR, ''), false);
});
