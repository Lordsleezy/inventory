import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { androidPrintPath, labelPrintKind } from './labelPrintKind.ts';

test('the store phone opens the Android print dialog instead of a hidden PDF frame', () => {
  const moto = 'Mozilla/5.0 (Linux; Android 14; moto g play - 2024) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  assert.equal(labelPrintKind(moto), 'android');
  assert.equal(labelPrintKind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
  assert.equal(labelPrintKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'), 'frame');
});

test('android print leaves the installed app for a page that calls the phone printer', () => {
  assert.equal(androidPrintPath('job 1'), '/label-print.html?job=job%201');
  const page = readFileSync(new URL('../public/label-print.html', import.meta.url), 'utf8');
  assert.match(page, /window\.print\(\)/);
  assert.match(page, /floor-print-/);
  assert.match(page, /display-mode: standalone/);
  assert.doesNotMatch(page, /application\/pdf/);
});
