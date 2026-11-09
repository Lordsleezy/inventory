import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { labelPrintKind } from './labelPrintKind.ts';

test('the store phone opens the Android print dialog instead of a hidden PDF frame', () => {
  const moto = 'Mozilla/5.0 (Linux; Android 14; moto g play - 2024) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  assert.equal(labelPrintKind(moto), 'android');
  assert.equal(labelPrintKind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
  assert.equal(labelPrintKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'), 'frame');
});

test('android print stays on the orders page and calls the system print sheet', () => {
  const src = readFileSync(new URL('./labelPrint.ts', import.meta.url), 'utf8');
  const orders = readFileSync(new URL('./appMode/AppOrders.tsx', import.meta.url), 'utf8');
  assert.match(src, /async function printOnAndroid[\s\S]*window\.print\(\)/);
  assert.match(src, /floor-label-print/);
  assert.doesNotMatch(src, /Building the label|intent:\/\/|about:blank|startAndroidPrint/);
  assert.doesNotMatch(orders, /startAndroidPrint/);
});
