import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

test('admin ship override has a Mark shipped button after the reason', async () => {
  const sheet = await readFile(path.join(root, 'AppOrderShipVerifySheet.tsx'), 'utf8');
  const css = await readFile(path.join(root, 'ordersApp.css'), 'utf8');
  assert.match(sheet, /placeholder="Why there is no tracking"/);
  assert.match(sheet, /className="primary app-order-verify-ship"/);
  assert.match(sheet, />\s*Mark shipped\s*</);
  assert.match(sheet, /disabled=\{busy \|\| overrideReason\.trim\(\)\.length < 4\}/);
  assert.match(sheet, /onClick=\{\(\) => submit\(\)\}/);
  assert.match(sheet, /if \(e\.key === 'Enter'\)/);
  assert.match(css, /html\.app-mode \.app-order-verify-ship \{ width: 100%; min-height: 48px; font-size: 16px; \}/);
  assert.match(css, /html\.app-mode \.app-order-verify-ship:disabled \{[\s\S]*color: #8e8e93 !important;/);
});
