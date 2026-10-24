import assert from 'node:assert/strict';
import test from 'node:test';
import { countManifestRows, parseManifestCsv } from './manifestCount.ts';

test('manifest count uses quantity, not the number of lines', () => {
  assert.equal(countManifestRows(parseManifestCsv('SKU,Quantity\r\nA,3\r\nB,2\r\n')), 5);
});

test('manifest count retains first item in a headerless sheet', () => {
  assert.equal(countManifestRows(parseManifestCsv('A,Brush\nB,Head\n')), 2);
});
