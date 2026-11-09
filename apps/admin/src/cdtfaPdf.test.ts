import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { fillCdtfaPdfBytes } from './books/cdtfaPdf.ts';

const november = [
  ['1', 2760], ['2', 0], ['3', 2760],
  ['4', 0], ['5', 0], ['6', 0], ['7', 0], ['8', 0], ['9', 0], ['10', 1233], ['A11', 1233],
  ['B1', 0], ['B2', 0], ['B3', 0], ['B4', 0], ['B5', 0],
  ['11', 1233], ['12', 1527], ['13', 92], ['14', 4], ['15', 15], ['16', 0],
  ['17', 111], ['18', 0], ['19', 111],
  ['20a', 0], ['20b', 0], ['20c', 0], ['20d', 0], ['20e', 0],
  ['21', 111], ['22', 0], ['23', 111], ['24', 0], ['25', 0], ['26', 111],
].map(([id, dollars]) => ({ id: String(id), dollars: Number(dollars) }));

test('the filled CDTFA-401-A keeps line 26 on the total, not the penalty', async () => {
  const src = readFileSync(new URL('../public/cdtfa/cdtfa401a.pdf', import.meta.url));
  const out = await fillCdtfaPdfBytes(src, {
    period_start: '2026-11-01',
    period_end: '2026-11-30',
    due_on: '2026-12-31',
    lines: november,
    open: true,
    optionTitle: 'Monthly filing option',
    optionHint: 'File only one schedule — whichever CDTFA assigned.',
  });
  const pdf = await PDFDocument.load(out);
  const form = pdf.getForm();
  const text = (name: string) => form.getTextField(name).getText();
  assert.equal(text('23'), '111');
  assert.equal(text('26'), '0');
  assert.equal(text('29'), '0');
  assert.equal(text('30'), '111');
  assert.equal(text('31'), '0');
  assert.equal(text('52'), '0');
  assert.equal(text('22'), '0');
  assert.equal(text('22a'), '0');
  assert.equal(text('22b'), '0');
  assert.equal(text('1'), '2760');
  assert.equal(text('12'), '1527');
  assert.equal(text('17'), '111');
  assert.equal(text('38'), '1233');
  assert.equal(text('45'), '1233');
  assert.equal(text('A2'), '1527');
  assert.equal(text('A2-A4'), '1527');
  assert.equal(text('A5'), '0');
  assert.equal(text('ReportingPeriod'), '11/01/2026 - 11/30/2026');
  assert.equal(text('Period Begin'), '11/01/2026');
  assert.equal(text('Period End'), '11/30/2026');
  assert.equal(text('PaidName') ?? '', '');
});

test('interest stays blank when asked, and a preparer is the only name in that box', async () => {
  const src = readFileSync(new URL('../public/cdtfa/cdtfa401a.pdf', import.meta.url));
  const out = await fillCdtfaPdfBytes(src, {
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    due_on: '2026-10-31',
    lines: november.map((line) => line.id === '24' ? { ...line, dollars: 11 } : line.id === '26' ? { ...line, dollars: 122 } : line),
    omitInterest: true,
    preparer: 'Ada',
    signer: { account: '012-345' },
  });
  const pdf = await PDFDocument.load(out);
  const form = pdf.getForm();
  assert.equal(form.getTextField('29').getText() ?? '', '');
  assert.equal(form.getTextField('PaidName').getText(), 'Ada');
  assert.equal(form.getTextField('AccountNumber').getText(), '012-345');
  assert.equal(form.getTextField('26').getText(), '11');
});
