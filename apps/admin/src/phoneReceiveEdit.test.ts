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
  assert.match(drawer, /appMode \? <textarea rows=\{2\} value=\{form\.brand\}/);
  assert.match(drawer, /: <input value=\{form\.brand\}/);
  const main = await readFile(path.join(root, 'main.tsx'), 'utf8');
  const typeCss = await readFile(path.join(root, 'appMode/phoneEditType.css'), 'utf8');
  assert.match(main, /import '\.\/design\/desk\.css';\r?\nimport '\.\/appMode\/phoneEditType\.css';/);
  assert.match(typeCss, /html\.app-mode \.app-unit-edit/);
  assert.match(typeCss, /text-align: left !important/);
  assert.match(typeCss, /font-weight: 700 !important/);
  assert.match(drawer, /staff_set_unit_do_not_list/);
  assert.match(drawer, /className="unit-edit-flags"/);
  assert.match(drawer, /\{!appMode && <ChannelCheckboxes/);
  assert.doesNotMatch(drawer, /\{appMode && \(\s*<div className="unit-edit-flags"/);
  const desk = await readFile(path.join(root, 'design/desk.css'), 'utf8');
  assert.match(desk, /html\.desk:not\(\.app-mode\) \.unit-edit-flags/);
  assert.match(desk, /html\.desk:not\(\.app-mode\) label\.unit-edit-notes/);
  assert.match(typeCss, /html\.app-mode \.app-unit-edit \.unit-edit-flag input\[type="checkbox"\]/);
});
