import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

test('Orders screens no longer mount proposed-refund / Apply bundle price chrome', async () => {
  const app = await readFile(path.join(root, 'appMode/AppOrders.tsx'), 'utf8');
  const desk = await readFile(path.join(root, 'OrdersPage.tsx'), 'utf8');
  const bar = await readFile(path.join(root, 'BundleBar.tsx'), 'utf8');
  assert.doesNotMatch(app, /import \{ BundleBar \}/);
  assert.doesNotMatch(desk, /import \{ BundleBar \}/);
  assert.doesNotMatch(app, /Proposed refund|Apply bundle price|tempFlatLine/);
  assert.doesNotMatch(desk, /Proposed refund|Apply bundle price/);
  assert.match(bar, /return null/);
  assert.match(app, /portal_bundle_orders|orders-bundle-bar|AppShipmentCard/);
  assert.match(app, /AppShipmentDetail|onOpenShipment/);
});

test('phone Orders heading is solid white, not gray', async () => {
  const css = await readFile(path.join(root, 'appMode/ordersApp.css'), 'utf8');
  // Match the eyebrow rule itself, not .orders-screen-eyebrow-row.
  const start = css.indexOf('.orders-screen-eyebrow {');
  assert.ok(start >= 0, 'orders-screen-eyebrow rule missing');
  const block = css.slice(start, start + 320);
  assert.match(block, /color:\s*#fff/);
  assert.doesNotMatch(block, /color:\s*#9a9a9a/);
});
