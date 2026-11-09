import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

test('More home lists primary links in the phone order ending with Other', async () => {
  const src = await readFile(path.join(root, 'AppMore.tsx'), 'utf8');
  const home = src.slice(src.indexOf('export function AppMoreHome'), src.indexOf('export function AppMoreOther'));
  const admin = home.slice(home.indexOf('{fullAccess ? ('), home.indexOf(') : ownerAccess ? ('));
  const labels = [...admin.matchAll(/Icon tone="[^"]+" \/>([^<]+)</g)].map((m) => m[1].trim());
  assert.deepEqual(labels, ['Live sales', 'Receipts', 'Register', 'Safe', 'Reports', 'Books', 'Locations', 'Returns', 'Other']);
});

test('Owner More lists money and system extras', async () => {
  const src = await readFile(path.join(root, 'AppMore.tsx'), 'utf8');
  const owner = src.slice(src.indexOf('function OwnerMoreHome'), src.indexOf('export function AppMoreHome'));
  const labels = [...owner.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Manifests', 'Locations', 'Reports', 'Books', 'Safe', 'Cameras', 'Settings']);
});

test('Other page keeps marketplace and leftover admin links', async () => {
  const src = await readFile(path.join(root, 'AppMore.tsx'), 'utf8');
  const other = src.slice(src.indexOf('export function AppMoreOther'), src.indexOf('export function AppLiveSales'));
  for (const label of ['eBay', 'Amazon', 'TikTok', 'Depop', 'Connections & sync', 'Dropship', 'Insights', 'Manifests', 'Settings']) {
    assert.match(other, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
