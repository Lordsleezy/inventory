import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { squareLaunchUrl } from './squareLaunch.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

test('Open Square is a same-page app link, not a blocked popup', async () => {
  const sheet = await readFile(path.join(root, 'NativeRegister.tsx'), 'utf8');
  assert.equal(squareLaunchUrl('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'square-commerce-v1://');
  assert.match(squareLaunchUrl('Mozilla/5.0 (Linux; Android 14)'), /^intent:#Intent;.*package=com\.squareup;end$/);
  assert.doesNotMatch(sheet, /window\.open/);
  assert.doesNotMatch(sheet, /squareup\.com\/dashboard/);
  assert.doesNotMatch(sheet, /squareup:\/\//);
  assert.match(sheet, /href=\{squareLaunchUrl\(navigator\.userAgent\)\}>Open Square</);
});
