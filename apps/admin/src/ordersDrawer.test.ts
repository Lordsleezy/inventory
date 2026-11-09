import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

test('desktop order sheet is an opaque panel and upload is a real button', async () => {
  const bw = await readFile(path.join(root, 'design/bw.css'), 'utf8');
  const desk = await readFile(path.join(root, 'design/desk.css'), 'utf8');
  const orders = await readFile(path.join(root, 'OrdersPage.tsx'), 'utf8');
  assert.match(bw, /html\.dark \.app > aside,/);
  const transparent = bw.slice(bw.indexOf('html.dark .inventory-row'), bw.indexOf('html.dark button.primary'));
  assert.match(transparent, /html\.dark \.app > aside/);
  assert.doesNotMatch(transparent, /html\.dark aside,/);
  assert.match(desk, /html\.desk:not\(\.app-mode\) \.app > aside \{/);
  assert.match(desk, /\.desk-drawer \{[\s\S]*background: #111 !important/);
  assert.match(desk, /\.desk-drawer-scrim \{ position: fixed; inset: 0; background: #000000aa; z-index: 39/);
  assert.match(orders, /createPortal\(/);
  assert.match(orders, /className="desk-drawer"/);
  assert.doesNotMatch(orders, /<aside className="desk-drawer"/);
  assert.match(orders, /className="primary" disabled=\{!!busy\} onClick=\{\(\) => document\.getElementById\(`order-label-\$\{o\.id\}`\)\?\.click\(\)\}/);
  assert.doesNotMatch(orders, /<label className="primary"/);
});
