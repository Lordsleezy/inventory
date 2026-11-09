import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadErrorMessage } from './booksLoadErrors.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

test('Books load errors surface access denial in plain English', () => {
  assert.match(loadErrorMessage({ message: 'portal_access_denied' }, 'month'), /permission/i);
  assert.match(loadErrorMessage(new Error('network'), 'month'), /Could not load this month/i);
});

test('owner financial migration opens Books and payout commissions to financial access', async () => {
  const sql = await readFile(path.join(root, '..', '..', '..', 'supabase', 'migrations', '20261228160000_owner_financial_books.sql'), 'utf8');
  assert.match(sql, /portal_financial_access\(\)/);
  assert.match(sql, /new_guard text := 'if not public.portal_financial_access\(\)/);
  assert.match(sql, /portal_books_report/);
  assert.match(sql, /portal_payout_commissions/);
});
