import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import { LABEL_H, LABEL_W, PAPER_H, PAPER_W, fitLabelBox, normalizeLabelPdf } from './labelPrint.ts';

test('a letter page shrinks into the 4x6 box and a small page enlarges', () => {
  const letter = fitLabelBox(8.5 * 72, 11 * 72);
  assert.ok(letter.width <= LABEL_W + 0.01);
  assert.ok(letter.height <= LABEL_H + 0.01);
  assert.ok(Math.abs(letter.width - LABEL_W) < 0.01);
  assert.ok(letter.height < LABEL_H);

  const exact = fitLabelBox(LABEL_W, LABEL_H);
  assert.equal(exact.width, LABEL_W);
  assert.equal(exact.height, LABEL_H);

  const small = fitLabelBox(100, 100);
  assert.ok(small.scale > 1);
  assert.ok(Math.abs(small.width - LABEL_W) < 0.01);
});

test('normalized labels are a letter sheet so 4x6 stays 4x6 on 8.5x11 paper', async () => {
  const src = await PDFDocument.create();
  const page = src.addPage([LABEL_W, LABEL_H]);
  page.drawRectangle({ x: 10, y: 10, width: 40, height: 40 });
  const outBytes = await normalizeLabelPdf(await src.save());
  const out = await PDFDocument.load(outBytes);
  const printed = out.getPages()[0];
  assert.equal(printed.getWidth(), PAPER_W);
  assert.equal(printed.getHeight(), PAPER_H);
  const crop = printed.getCropBox();
  assert.equal(crop.width, PAPER_W);
  assert.equal(crop.height, PAPER_H);

  const letter = await PDFDocument.create();
  const wide = letter.addPage([11 * 72, 8.5 * 72]);
  wide.drawRectangle({ x: 10, y: 10, width: 40, height: 40 });
  wide.setRotation(degrees(90));
  const turned = await PDFDocument.load(await normalizeLabelPdf(await letter.save()));
  assert.equal(turned.getPages()[0].getWidth(), PAPER_W);
  assert.equal(turned.getPages()[0].getHeight(), PAPER_H);
});
