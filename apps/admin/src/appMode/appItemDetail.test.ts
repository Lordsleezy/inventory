import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = () => readFile(path.join(root, 'AppItemDetail.tsx'), 'utf8');

test('phone item page hides marketplaces and shipping from clerks and keeps the UPC attention', async () => {
  const file = await source();
  assert.match(file, /app-item-attention/);
  assert.doesNotMatch(file, /Set location/);
  assert.match(file, /Add UPC/);
  assert.match(file, /staff_set_unit_upc/);
  assert.match(file, /portal_set_unit_upc/);
  assert.match(file, /No UPC/);
  assert.match(file, /Fill from UPC/);
  assert.match(file, /\{!staffMode && \(/);
  assert.match(file, /Selling on/);
  assert.match(file, /Pricing & cost/);
  assert.doesNotMatch(file, /app-selling-on/);
  assert.match(file, /staff_inventory_detail/);
  assert.match(file, /app-item-hero/);
  assert.match(file, /app-nav-title">Item</);
});
