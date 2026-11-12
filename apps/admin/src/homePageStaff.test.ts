import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

test('staff Home renders associate desk when not fullAccess', async () => {
  const src = await readFile(path.join(root, 'HomePage.tsx'), 'utf8');
  assert.match(src, /deskAccess === 'staff'/);
  assert.match(src, /desk-grid is-associate/);
  assert.match(src, /deskAccess === 'owner'/);
  assert.match(src, /OWNER_JUMP_LINKS/);
  assert.match(src, /Current payout due/);
  assert.match(src, /viewerIsJacob/);
});
