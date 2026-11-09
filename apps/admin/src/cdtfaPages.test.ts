import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { classifyCdtfaPage, selectCdtfaPages } from './books/cdtfaPages.ts';
import { fillCdtfaPdfBytes, trimCdtfaPdfBytes } from './books/cdtfaPdf.ts';
import { buildCdtfaWorksheet } from './books/cdtfaWorksheet.ts';

async function templateTexts() {
  const data = new Uint8Array(readFileSync(new URL('../public/cdtfa/cdtfa401a.pdf', import.meta.url)));
  const doc = await getDocument({ data }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  return texts;
}

test('a zero district tax keeps the three return pages and drops instructions', async () => {
  const texts = await templateTexts();
  const plan = selectCdtfaPages(texts, 0);
  assert.equal(plan.warning, null);
  assert.deepEqual(plan.kinds.filter((kind) => kind === 'instructions').length > 0, true);
  assert.deepEqual(plan.keep.map((index) => plan.kinds[index]), ['return', 'return', 'return']);
  for (const index of plan.keep) {
    assert.equal(/INSTRUCTIONS FOR COMPLETING/i.test(texts[index]), false);
    assert.equal(/Fixed-price contract example/i.test(texts[index]), false);
  }
});

test('district tax keeps the schedule and still drops instructions and examples', async () => {
  const texts = await templateTexts();
  const plan = selectCdtfaPages(texts, 12);
  assert.equal(plan.warning, null);
  assert.ok(plan.keep.length > 3);
  assert.equal(plan.keep.every((index) => plan.kinds[index] === 'return' || plan.kinds[index] === 'schedule'), true);
  assert.equal(plan.kinds.includes('instructions'), true);
  assert.equal(plan.keep.some((index) => plan.kinds[index] === 'instructions'), false);
  assert.equal(plan.keep.some((index) => plan.kinds[index] === 'example'), false);
});

test('an unrecognized page keeps the whole file and warns', () => {
  const plan = selectCdtfaPages(['CDTFA-401-A (S1F) return', 'something new from CDTFA'], 0);
  assert.equal(classifyCdtfaPage('something new from CDTFA'), 'unknown');
  assert.deepEqual(plan.keep, [0, 1]);
  assert.match(plan.warning || '', /full file/);
});

test('the trimmed return stays fillable and the account number is on every account box', async () => {
  const src = readFileSync(new URL('../public/cdtfa/cdtfa401a.pdf', import.meta.url));
  const texts = await templateTexts();
  const plan = selectCdtfaPages(texts, 0);
  const filled = await fillCdtfaPdfBytes(src, {
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    due_on: '2026-10-31',
    lines: [{ id: '1', dollars: 1363 }, { id: '16', dollars: 0 }, { id: '26', dollars: 99 }],
    signer: { account: '012-345' },
  });
  const trimmed = await trimCdtfaPdfBytes(filled, plan.keep);
  const pdf = await PDFDocument.load(trimmed);
  assert.equal(pdf.getPageCount(), 3);
  const form = pdf.getForm();
  assert.equal(form.getTextField('1').getText(), '1363');
  form.getTextField('1').setText('1400');
  assert.equal(form.getTextField('1').getText(), '1400');
  assert.equal(form.getTextField('PaidName').getText() ?? '', '');
  const doc = await getDocument({ data: trimmed }).promise;
  assert.equal(doc.numPages, 3);
  let accountBoxes = 0;
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
    assert.equal(/INSTRUCTIONS FOR COMPLETING/i.test(text), false);
    const anns = await page.getAnnotations();
    for (const ann of anns) {
      if (ann.fieldName !== 'AccountNumber') continue;
      accountBoxes += 1;
      assert.equal(ann.fieldValue, '012-345');
    }
  }
  assert.equal(accountBoxes, 2);
  const pages = pdf.getPages();
  const refs = new Set(pages.map((page) => page.ref));
  for (const field of form.getFields()) {
    for (const widget of field.acroField.getWidgets()) {
      const ref = widget.P();
      assert.equal(ref != null && refs.has(ref), true);
    }
  }
});

test('the worksheet is one separate page', async () => {
  const bytes = await buildCdtfaWorksheet({
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    dueOn: '2026-10-31',
    fileOn: '2026-11-08',
    late: true,
    pageCount: 3,
    scheduleIncluded: false,
    lines: [
      { id: '1', label: 'Total sales', dollars: 1363, note: 'Register sales.' },
      { id: '10', label: 'Marketplace', dollars: 0, note: 'None this period.' },
      { id: '12', label: 'Taxable', dollars: 1363 },
      { id: '13', label: 'State', dollars: 82 },
      { id: '14', label: 'County', dollars: 3 },
      { id: '15', label: 'Local', dollars: 14 },
      { id: '16', label: 'District', dollars: 0 },
      { id: '17', label: 'Total tax', dollars: 99 },
      { id: '23', label: 'Net tax', dollars: 99 },
      { id: '24', label: 'Penalty', dollars: 10 },
      { id: '25', label: 'Interest', dollars: 0 },
      { id: '26', label: 'Total due', dollars: 109 },
    ],
  });
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
});
