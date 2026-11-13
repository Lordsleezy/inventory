import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

test('Receive condition chips are New, Open box, Used Good, Used Fair (no Excellent)', async () => {
  const receive = await readFile(path.join(root, 'ReceivePanel.tsx'), 'utf8');
  assert.match(receive, /RECEIVE_CONDITION_CHIPS/);
  assert.match(receive, /\[NEW, 'New'\], \[OPEN, 'Open box'\], \[USED_GOOD, 'Used · Good'\], \[USED_FAIR, 'Used · Fair'\]/);
  assert.doesNotMatch(receive, /allowedGrades \|\| \[\]\)\.map\(grade =>/);
  assert.doesNotMatch(receive, /Pick a category first\. eBay decides which conditions/);
  const grades = await readFile(path.join(root, '../../../netlify/lib/ebay-conditions.mjs'), 'utf8');
  assert.match(grades, /"Used - Good"/);
  assert.match(grades, /"Used - Fair"/);
  assert.doesNotMatch(grades, /FLOOR_CONDITION_GRADES = \[[^\]]*Excellent/s);
});
