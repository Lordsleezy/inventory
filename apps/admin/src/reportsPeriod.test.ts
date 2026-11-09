import test from 'node:test';
import assert from 'node:assert/strict';
import { choiceBounds, defaultPeriodId, periodChoices, reportFileStem, yearsFrom } from './books/reportsPeriod.ts';

const november = new Date(2026, 10, 8);

test('period list groups quarters then months and disables the future', () => {
  const choices = periodChoices(2026, november);
  assert.deepEqual(choices.slice(0, 4).map((row) => row.group), ['Quarters', 'Quarters', 'Quarters', 'Quarters']);
  assert.equal(choices.filter((row) => row.group === 'Months').length, 12);
  const december = choices.find((row) => row.id === 'm12');
  assert.equal(december?.disabled, true);
  const q4 = choices.find((row) => row.id === 'q4');
  assert.equal(q4?.disabled, false);
  assert.equal(q4?.inProgress, true);
  const current = choices.find((row) => row.id === 'm11');
  assert.equal(current?.disabled, false);
  assert.equal(current?.inProgress, true);
  assert.match(current?.label || '', /in progress/);
  const q3 = choices.find((row) => row.id === 'q3');
  assert.equal(q3?.disabled, false);
});

test('default is the current month and years stop at this year', () => {
  assert.equal(defaultPeriodId(november), 'm11');
  assert.deepEqual(yearsFrom(2024, november), [2024, 2025, 2026]);
  assert.equal(choiceBounds(2026, 'm11').span, 'month');
  assert.equal(choiceBounds(2026, 'q3').start, '2026-07-01');
  assert.equal(choiceBounds(2026, 'q3').end, '2026-09-30');
  assert.equal(reportFileStem(2026, 'm11'), 'Open-Box_Reports_2026-11');
  assert.equal(reportFileStem(2026, 'q3'), 'Open-Box_Reports_2026-Q3');
});
