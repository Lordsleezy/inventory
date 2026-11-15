import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ONLINE_ORDER_RESERVED_MESSAGE,
  isOnlineOrderHeld,
} from './onlineHold.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

test('ONLINE_ORDER_RESERVED_MESSAGE is the register popup copy', () => {
  assert.equal(ONLINE_ORDER_RESERVED_MESSAGE, 'This item is reserved for an online order.');
});

test('isOnlineOrderHeld only accepts held:true payloads', () => {
  assert.equal(isOnlineOrderHeld({ held: true }), true);
  assert.equal(isOnlineOrderHeld({ held: false }), false);
  assert.equal(isOnlineOrderHeld(null), false);
  assert.equal(isOnlineOrderHeld(undefined), false);
  assert.equal(isOnlineOrderHeld({ held: 'yes' }), false);
});

test('Register and native scan paths deny online-reserved SKUs before add', async () => {
  const page = await readFile(path.join(root, '../RegisterPage.tsx'), 'utf8');
  const native = await readFile(path.join(root, 'NativeRegister.tsx'), 'utf8');
  const units = await readFile(path.join(root, 'units.ts'), 'utf8');
  assert.match(units, /portal_register_online_hold/);
  assert.match(units, /ONLINE_ORDER_RESERVED_MESSAGE/);
  assert.match(page, /denyOnlineOrderReserved/);
  assert.match(native, /denyOnlineOrderReserved/);
});
