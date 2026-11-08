import test from 'node:test';
import assert from 'node:assert/strict';
import { filingOption, formKind, monthsInRange, parseFiling, quarterStart, recordsStamp, spanBounds, spanTitle } from './books/booksSpan.ts';
import { roundingNote } from './books/cdtfaRoundNote.ts';

test('a month report and a quarter report are different forms', () => {
  assert.equal(recordsStamp('month', 'quarterly'), 'FOR RECORDS — DO NOT FILE (this store files quarterly)');
  assert.equal(recordsStamp('quarter', 'quarterly'), null);
  assert.equal(recordsStamp('quarter', 'monthly'), 'FOR RECORDS — DO NOT FILE (this store files monthly)');
  assert.equal(recordsStamp('month', 'yearly'), 'FOR RECORDS — DO NOT FILE (this store files yearly)');
  assert.equal(recordsStamp('quarter', 'yearly'), 'FOR RECORDS — DO NOT FILE (this store files yearly)');
  assert.equal(recordsStamp('year', 'yearly'), null);
  assert.equal(recordsStamp('month', null), null);
  assert.equal(recordsStamp('quarter', null), null);
  assert.equal(parseFiling(''), null);
  assert.equal(parseFiling('quarterly'), 'quarterly');
  assert.equal(filingOption('month', null)?.title, 'Monthly filing option');
  assert.equal(filingOption('quarter', null)?.title, 'Quarterly filing option');
  assert.equal(filingOption('month', null)?.hint, 'File only one schedule — whichever CDTFA assigned.');
  assert.equal(filingOption('month', 'quarterly'), null);
});

test('October sits in Q4 and the quarter covers three months', () => {
  assert.equal(quarterStart('2026-10-01'), '2026-10-01');
  assert.deepEqual(spanBounds('2026-11-08', 'quarter'), { start: '2026-10-01', end: '2026-12-31' });
  assert.deepEqual(monthsInRange('2026-10-01', '2026-12-31'), ['2026-10-01', '2026-11-01', '2026-12-01']);
  assert.equal(spanTitle('2026-10-01', 'quarter'), 'Q4 2026');
  assert.equal(formKind('2026-10-01', '2026-10-31'), 'month');
  assert.equal(formKind('2026-10-01', '2026-12-31'), 'quarter');
  assert.equal(formKind('2026-01-01', '2026-12-31'), 'year');
});

test('a dollar of rounding is a note, and matching lines are quiet', () => {
  const quarter = [{ id: '12', dollars: 7741 }, { id: '17', dollars: 560 }];
  const months = [
    [{ id: '12', dollars: 5000 }, { id: '17', dollars: 362 }],
    [{ id: '12', dollars: 2742 }, { id: '17', dollars: 199 }],
    [{ id: '12', dollars: 0 }, { id: '17', dollars: 0 }],
  ];
  const note = roundingNote(quarter, months);
  assert.match(note || '', /line 12 is \$7,741 here and \$7,742/);
  assert.match(note || '', /line 17 is \$560 here and \$561/);
  assert.equal(roundingNote(quarter, [quarter]), null);
});
