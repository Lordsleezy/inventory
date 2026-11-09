import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { androidPrintDocument, androidPrintPath, chromeLabelIntent, labelPrintKind } from './labelPrintKind.ts';

test('the store phone opens the Android print dialog instead of a hidden PDF frame', () => {
  const moto = 'Mozilla/5.0 (Linux; Android 14; moto g play - 2024) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  assert.equal(labelPrintKind(moto), 'android');
  assert.equal(labelPrintKind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
  assert.equal(labelPrintKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'), 'frame');
});

test('android print opens the phone printer list from a real label page', () => {
  assert.equal(androidPrintPath('job 1'), '/label-print.html?job=job%201');
  const page = androidPrintDocument('https://admin.example', ['https://files.example/a.png?token=abc'], 'label');
  assert.equal(
    page,
    'https://admin.example/label-print.html?src=https%3A%2F%2Ffiles.example%2Fa.png%3Ftoken%3Dabc&paper=label',
  );
  const intent = chromeLabelIntent(page);
  const split = intent.indexOf('#Intent;');
  assert.equal(`https://${intent.slice('intent://'.length, split)}`, page);
  assert.match(intent, /package=com\.android\.chrome;category=android\.intent\.category\.BROWSABLE;end$/);
  assert.doesNotMatch(intent, /browser_fallback_url|googlechrome:/);
  assert.equal(chromeLabelIntent('http://files.example/label.pdf'), '');
  const src = readFileSync(new URL('./labelPrint.ts', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/label-print.html', import.meta.url), 'utf8');
  assert.match(src, /androidPrintDocument/);
  assert.match(src, /<a id="print"/);
  assert.doesNotMatch(src, /googlechrome:|browser_fallback_url|sourceUrl/);
  assert.match(html, /window\.print\(\)/);
  assert.match(html, /getAll\('src'\)/);
  assert.doesNotMatch(html, /googlechrome:|intent:/);
});
