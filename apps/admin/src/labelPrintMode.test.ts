import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { androidPrintPath, chromeLabelIntent, labelPrintKind } from './labelPrintKind.ts';

test('the store phone opens the Android print dialog instead of a hidden PDF frame', () => {
  const moto = 'Mozilla/5.0 (Linux; Android 14; moto g play - 2024) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  assert.equal(labelPrintKind(moto), 'android');
  assert.equal(labelPrintKind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
  assert.equal(labelPrintKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'), 'frame');
});

test('android print leaves the installed app and opens the label in Chrome', () => {
  assert.equal(androidPrintPath('job 1'), '/label-print.html?job=job%201');
  const intent = chromeLabelIntent('https://files.example/label.pdf?token=abc');
  assert.equal(
    intent,
    'intent://files.example/label.pdf?token=abc#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Ffiles.example%2Flabel.pdf%3Ftoken%3Dabc;end',
  );
  assert.equal(chromeLabelIntent('http://files.example/label.pdf'), '');
  const src = readFileSync(new URL('./labelPrint.ts', import.meta.url), 'utf8');
  assert.match(src, /chromeLabelIntent/);
  assert.match(src, /<a id="print"/);
  assert.doesNotMatch(src, /window\.print\(\)/);
});
