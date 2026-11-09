import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

test('phone receive sections toggle, and category preview does not need a SKU', async () => {
  const receive = await readFile(path.join(root, 'ReceivePanel.tsx'), 'utf8');
  assert.match(receive, /const toggleSection = \(id: string\) => setOpenSec\(current => current === id \? '' : id\)/);
  assert.doesNotMatch(receive, /onOpen=\{setOpenSec\}/);
  assert.match(receive, /className="rcv-dnl"/);
  assert.match(receive, /id="location"/);
  const fn = await readFile(path.join(root, '../../../netlify/functions/ebay-specifics.mjs'), 'utf8');
  assert.match(fn, /body\.action !== "preview-receive"/);
});

test('phone item edit keeps the desktop drawer on the desktop path', async () => {
  const drawer = await readFile(path.join(root, 'UnitEditDrawer.tsx'), 'utf8');
  assert.match(drawer, /className=\{`inventory-backdrop\$\{appMode \? ' app-unit-edit' : ''\}`\}/);
  assert.match(drawer, /\{appMode \? \(/);
  const css = await readFile(path.join(root, 'design/bw.css'), 'utf8');
  assert.match(css, /html\.app-mode \.app-edit-section-chips button\.is-active/);
  assert.doesNotMatch(css, /(?<!html\.app-mode )\.app-edit-section-chips button\.is-active \{[^}]*background:\s*#fff/);
});
