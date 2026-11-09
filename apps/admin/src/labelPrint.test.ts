import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib';
import bwipjs from 'bwip-js';
import sharp from 'sharp';
// @ts-expect-error plain JavaScript decoder, used only to prove the barcode still scans
import { decodeTrackingBarcodes } from '../../../netlify/lib/tracking-barcode.mjs';
import { LABEL_H, LABEL_W, LETTER_H, LETTER_W, QUARTER_H, QUARTER_W, SAFE_MARGIN, buildLabelPdf } from './labelSheet.ts';

const TRACK = '9400108106244728534798';
const OUT = tmpdir();

async function scan(png: Buffer) {
  const trimmed = await sharp(png).trim({ threshold: 15 }).png().toBuffer();
  return decodeTrackingBarcodes(trimmed);
}

async function barcodePng() {
  return bwipjs.toBuffer({ bcid: 'code128', text: TRACK, scale: 3, height: 12, includetext: true });
}

function mul(m: number[], n: number[]) {
  const [a, b, c, d, e, f] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
}

async function renderPng(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const scale = 2;
  const pageW = page.view[2] - page.view[0];
  const pageH = page.view[3] - page.view[1];
  const width = Math.round(pageW * scale);
  const height = Math.round(pageH * scale);
  const op = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const composites: { input: Buffer; left: number; top: number; dw: number; dh: number; ctm: number[] }[] = [];
  for (let i = 0; i < op.fnArray.length; i += 1) {
    const fn = op.fnArray[i];
    const args = op.argsArray[i] as unknown;
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm.slice());
      if (fn === OPS.paintFormXObjectBegin && Array.isArray(args)) {
        const matrix = (args as unknown[])[0];
        if (Array.isArray(matrix) && matrix.length >= 6) ctm = mul(ctm, matrix as number[]);
      }
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform && Array.isArray(args)) ctm = mul(ctm, args as number[]);
    else if (fn === OPS.paintImageXObject) {
      const name = Array.isArray(args) ? String(args[0]) : '';
      const img = await new Promise<Record<string, unknown>>((resolve) => page.objs.get(name, resolve));
      const iw = Number(img.width || 0);
      const ih = Number(img.height || 0);
      const data = img.data as Uint8Array | Uint8ClampedArray | undefined;
      if (!data || !iw || !ih) continue;
      const [a, b, c, d, e, f] = ctm;
      const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      const left = Math.max(0, Math.round(x0 * scale));
      const top = Math.max(0, Math.round((pageH - y1) * scale));
      const dw = Math.max(1, Math.round((x1 - x0) * scale));
      const dh = Math.max(1, Math.round((y1 - y0) * scale));
      const turns = ((Math.round(Math.atan2(b, a) * 180 / Math.PI / 90) * 90 % 360) + 360) % 360;
      const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const channels = raw.length >= iw * ih * 4 ? 4 : 3;
      const source = sharp(raw, { raw: { width: iw, height: ih, channels } });
      const pic = turns === 90 || turns === 270
        ? source.resize(dh, dw, { fit: 'fill' }).rotate(turns === 90 ? -90 : 90)
        : source.resize(dw, dh, { fit: 'fill' }).rotate(turns);
      const input = await pic.png().toBuffer();
      composites.push({ input, left, top, dw, dh, ctm: ctm.map((n) => Math.round(n * 100) / 100) });
    }
  }
  const png = await sharp({ create: { width, height, channels: 4, background: '#ffffff' } }).composite(composites).png().toBuffer();
  return { png, width, height, images: composites.map((c) => ({ left: c.left, top: c.top, dw: c.dw, dh: c.dh, ctm: c.ctm })) };
}

test('a letter page with a sideways corner label becomes an upright 4x6', async () => {
  const png = await barcodePng();
  const src = await PDFDocument.create();
  const page = src.addPage([LETTER_W, LETTER_H]);
  const font = await src.embedFont(StandardFonts.HelveticaBold);
  const image = await src.embedPng(png);
  page.drawRectangle({ x: 306, y: 36, width: 270, height: 160, borderWidth: 1, color: rgb(1, 1, 1), borderColor: rgb(0, 0, 0) });
  page.drawText('USPS GROUND ADVANTAGE', { x: 430, y: 50, size: 11, font, rotate: degrees(90) });
  page.drawImage(image, { x: 360, y: 48, width: 150, height: 48, rotate: degrees(90) });
  const outBytes = await buildLabelPdf(await src.save(), 'label');
  const out = await PDFDocument.load(outBytes);
  const printed = out.getPages()[0];
  assert.equal(printed.getWidth(), LABEL_W);
  assert.equal(printed.getHeight(), LABEL_H);
  assert.equal(printed.getRotation().angle % 360, 0);
  const shot = await renderPng(outBytes);
  writeFileSync(`${OUT}/label-sideways-4x6.png`, shot.png);
  assert.equal(shot.width, LABEL_W * 2);
  assert.equal(shot.height, LABEL_H * 2);
  const decoded = await scan(shot.png);
  assert.equal(decoded[0]?.number, TRACK, JSON.stringify(shot.images));
  const mark = shot.images[0];
  assert.ok(mark.left >= 8 && mark.left + mark.dw <= shot.width - 8, JSON.stringify(mark));
  assert.ok(mark.top >= 8 && mark.top + mark.dh <= shot.height - 8, JSON.stringify(mark));
});

test('a label already at 4x6 stays 4x6 and the barcode still scans', async () => {
  const png = await barcodePng();
  const src = await PDFDocument.create();
  const page = src.addPage([LABEL_W, LABEL_H]);
  const image = await src.embedPng(png);
  page.drawImage(image, { x: 36, y: 80, width: 216, height: 70 });
  const outBytes = await buildLabelPdf(await src.save(), 'label');
  const out = await PDFDocument.load(outBytes);
  assert.equal(out.getPages()[0].getWidth(), LABEL_W);
  assert.equal(out.getPages()[0].getHeight(), LABEL_H);
  const shot = await renderPng(outBytes);
  writeFileSync(`${OUT}/label-native-4x6.png`, shot.png);
  const decoded = await scan(shot.png);
  assert.equal(decoded[0]?.number, TRACK, JSON.stringify(shot.images));
  const mark = shot.images[0];
  assert.ok(mark.dw > 216 * 2, JSON.stringify(mark));
});

test('a 4x6 label in the top-left of a letter page is cropped out at full size', async () => {
  const png = await barcodePng();
  const src = await PDFDocument.create();
  const page = src.addPage([LETTER_W, LETTER_H]);
  const image = await src.embedPng(png);
  const top = LETTER_H - LABEL_H;
  page.drawRectangle({ x: 0, y: top, width: LABEL_W, height: LABEL_H, borderWidth: 1, color: rgb(1, 1, 1), borderColor: rgb(0, 0, 0) });
  page.drawImage(image, { x: 36, y: top + 80, width: 216, height: 70 });
  const outBytes = await buildLabelPdf(await src.save(), 'label');
  const out = await PDFDocument.load(outBytes);
  assert.equal(out.getPages()[0].getWidth(), LABEL_W);
  assert.equal(out.getPages()[0].getHeight(), LABEL_H);
  const shot = await renderPng(outBytes);
  writeFileSync(`${OUT}/label-top-left.png`, shot.png);
  const decoded = await scan(shot.png);
  assert.equal(decoded[0]?.number, TRACK, JSON.stringify(shot.images));
  const mark = shot.images[0];
  assert.ok(mark.left + mark.dw <= shot.width, JSON.stringify(mark));
  assert.ok(mark.dw > 180 * 2, JSON.stringify(mark));
});

test('letter paper keeps a true-size 4x6 label at the top-left', async () => {
  const png = await barcodePng();
  const src = await PDFDocument.create();
  const page = src.addPage([LABEL_W, LABEL_H]);
  const image = await src.embedPng(png);
  page.drawImage(image, { x: 36, y: 80, width: 216, height: 70 });
  const outBytes = await buildLabelPdf(await src.save(), 'letter');
  const out = await PDFDocument.load(outBytes);
  const printed = out.getPages()[0];
  assert.equal(printed.getWidth(), LETTER_W);
  assert.equal(printed.getHeight(), LETTER_H);
  const shot = await renderPng(outBytes);
  writeFileSync(`${OUT}/label-letter.png`, shot.png);
  assert.equal(shot.width, LETTER_W * 2);
  assert.equal(shot.height, LETTER_H * 2);
  const decoded = await scan(shot.png);
  assert.equal(decoded[0]?.number, TRACK, JSON.stringify(shot.images));
  const mark = shot.images[0];
  assert.ok(mark.left < 80, JSON.stringify(mark));
  assert.ok(mark.top < LABEL_H * 2, JSON.stringify(mark));
  assert.ok(mark.top + mark.dh < LABEL_H * 2, JSON.stringify(mark));
});

test('a sideways barcode on a 4x6 page is turned upright', async () => {
  const png = await barcodePng();
  const src = await PDFDocument.create();
  const page = src.addPage([LABEL_W, LABEL_H]);
  const image = await src.embedPng(png);
  page.drawImage(image, { x: 160, y: 40, width: 200, height: 64, rotate: degrees(90) });
  const outBytes = await buildLabelPdf(await src.save(), 'label');
  const out = await PDFDocument.load(outBytes);
  assert.equal(out.getPages()[0].getWidth(), LABEL_W);
  assert.equal(out.getPages()[0].getHeight(), LABEL_H);
  const shot = await renderPng(outBytes);
  writeFileSync(`${OUT}/label-rotated.png`, shot.png);
  const decoded = await scan(shot.png);
  assert.equal(decoded[0]?.number, TRACK, JSON.stringify(shot.images));
  const mark = shot.images[0];
  assert.ok(mark.dw > mark.dh, JSON.stringify(mark));
  assert.ok(mark.left >= 0 && mark.left + mark.dw <= shot.width, JSON.stringify(mark));
  assert.ok(mark.top >= 0 && mark.top + mark.dh <= shot.height, JSON.stringify(mark));
});

test('a wide label is fitted inside 4x6 without a letter page', async () => {
  const png = await barcodePng();
  const src = await PDFDocument.create();
  const page = src.addPage([LETTER_W, LETTER_H]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  const image = await src.embedPng(png);
  page.drawRectangle({ x: 40, y: 400, width: 360, height: 120, borderWidth: 2, borderColor: rgb(0, 0, 0) });
  page.drawText('WIDE LABEL', { x: 50, y: 490, size: 18, font });
  page.drawImage(image, { x: 50, y: 410, width: 200, height: 60 });
  const outBytes = await buildLabelPdf(await src.save(), 'label');
  const out = await PDFDocument.load(outBytes);
  assert.equal(out.getPages()[0].getWidth(), LABEL_W);
  assert.equal(out.getPages()[0].getHeight(), LABEL_H);
  const shot = await renderPng(outBytes);
  writeFileSync(`${OUT}/label-wide.png`, shot.png);
  const decoded = await scan(shot.png);
  assert.equal(decoded[0]?.number, TRACK, JSON.stringify(shot.images));
  const mark = shot.images[0];
  assert.ok(mark.left >= 0 && mark.left + mark.dw <= shot.width, JSON.stringify(mark));
  assert.ok(mark.top >= 0 && mark.top + mark.dh <= shot.height, JSON.stringify(mark));
  assert.ok(mark.dh < shot.height / 2, JSON.stringify(mark));
});

const DPI = 144;

async function inkInches(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const pageW = page.view[2] - page.view[0];
  const pageH = page.view[3] - page.view[1];
  const width = Math.round(pageW * DPI / 72);
  const height = Math.round(pageH * DPI / 72);
  const buf = Buffer.alloc(width * height * 4, 255);
  const op = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const paint = (x0: number, y0: number, x1: number, y1: number) => {
    if (Math.abs(x1 - x0) * Math.abs(y1 - y0) > pageW * pageH * 0.9) return;
    const left = Math.max(0, Math.floor(Math.min(x0, x1) * DPI / 72));
    const right = Math.min(width, Math.ceil(Math.max(x0, x1) * DPI / 72));
    const top = Math.max(0, Math.floor((pageH - Math.max(y0, y1)) * DPI / 72));
    const bottom = Math.min(height, Math.ceil((pageH - Math.min(y0, y1)) * DPI / 72));
    for (let y = top; y < bottom; y += 1) buf.fill(0, (y * width + left) * 4, (y * width + right) * 4);
  };
  for (let i = 0; i < op.fnArray.length; i += 1) {
    const fn = op.fnArray[i];
    const args = op.argsArray[i] as unknown;
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm.slice());
      if (fn === OPS.paintFormXObjectBegin && Array.isArray(args)) {
        const matrix = (args as unknown[])[0];
        if (Array.isArray(matrix) && matrix.length >= 6) ctm = mul(ctm, matrix as number[]);
      }
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform && Array.isArray(args)) ctm = mul(ctm, args as number[]);
    else if (fn === OPS.constructPath && Array.isArray(args)) {
      const minMax = (args as unknown[])[2];
      if (Array.isArray(minMax) && minMax.length >= 4) {
        const corners = [[minMax[0], minMax[1]], [minMax[2], minMax[3]]].map(([x, y]) => {
          const px = ctm[0] * Number(x) + ctm[2] * Number(y) + ctm[4];
          const py = ctm[1] * Number(x) + ctm[3] * Number(y) + ctm[5];
          return [px, py];
        });
        paint(corners[0][0], corners[0][1], corners[1][0], corners[1][1]);
      }
    } else if (fn === OPS.paintImageXObject) {
      const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      paint(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])));
    }
  }
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let p = 0; p < width * height; p += 1) {
    if (buf[p * 4] < 250) {
      const x = p % width;
      const y = Math.floor(p / width);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const png = await sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return {
    png,
    leftIn: minX / DPI,
    topIn: minY / DPI,
    widthIn: (maxX - minX + 1) / DPI,
    heightIn: (maxY - minY + 1) / DPI,
  };
}

function closeTo(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) / expected < 0.03, `${label}: measured ${actual.toFixed(3)} in, target ${expected.toFixed(3)} in`);
}

async function ebayCornerLabel() {
  const png = await barcodePng();
  const src = await PDFDocument.create();
  const page = src.addPage([LETTER_W, LETTER_H]);
  const font = await src.embedFont(StandardFonts.HelveticaBold);
  const image = await src.embedPng(png);
  const frameW = 230;
  const frameH = 230 / 0.77;
  page.drawRectangle({ x: 300, y: 40, width: frameW, height: frameH, borderWidth: 3, color: rgb(1, 1, 1), borderColor: rgb(0, 0, 0) });
  page.drawText('G', { x: 312, y: 40 + frameH - 36, size: 22, font });
  page.drawText('USPS GROUND ADVANTAGE', { x: 340, y: 40 + frameH - 32, size: 9, font });
  page.drawImage(image, { x: 318, y: 120, width: frameW - 40, height: 56 });
  page.drawRectangle({ x: 318, y: 58, width: 42, height: 42, color: rgb(0, 0, 0) });
  return src.save();
}

test('letter paper fills the top-left quarter with the label frame', async () => {
  const outBytes = await buildLabelPdf(await ebayCornerLabel(), 'letter');
  const out = await PDFDocument.load(outBytes);
  assert.equal(out.getPages()[0].getWidth(), LETTER_W);
  assert.equal(out.getPages()[0].getHeight(), LETTER_H);
  const ink = await inkInches(outBytes);
  writeFileSync(`${OUT}/label-quarter.png`, ink.png);
  const innerW = (QUARTER_W - SAFE_MARGIN * 2) / 72;
  const innerH = (QUARTER_H - SAFE_MARGIN * 2) / 72;
  closeTo(ink.widthIn, innerW, 'quarter width');
  closeTo(ink.heightIn, innerW / 0.77, 'quarter height');
  assert.ok(ink.heightIn < innerH * 1.03, `${ink.heightIn} taller than the quarter`);
  assert.ok(Math.abs(ink.leftIn - SAFE_MARGIN / 72) < 0.05, `quarter left ${ink.leftIn.toFixed(3)}`);
  assert.ok(Math.abs(ink.topIn - SAFE_MARGIN / 72) < 0.05, `quarter top ${ink.topIn.toFixed(3)}`);
  console.log(`letter quarter ink ${ink.widthIn.toFixed(3)} x ${ink.heightIn.toFixed(3)} in at ${ink.leftIn.toFixed(3)}, ${ink.topIn.toFixed(3)}`);
  const shot = await renderPng(outBytes);
  writeFileSync(`${OUT}/label-quarter-art.png`, shot.png);
  const decoded = await scan(shot.png);
  assert.equal(decoded[0]?.number, TRACK);
});

test('a 4x6 printer page scales the same frame up to fill the label', async () => {
  const outBytes = await buildLabelPdf(await ebayCornerLabel(), 'label');
  const out = await PDFDocument.load(outBytes);
  assert.equal(out.getPages()[0].getWidth(), LABEL_W);
  assert.equal(out.getPages()[0].getHeight(), LABEL_H);
  const ink = await inkInches(outBytes);
  writeFileSync(`${OUT}/label-fill-4x6.png`, ink.png);
  const innerW = (LABEL_W - SAFE_MARGIN * 2) / 72;
  const innerH = (LABEL_H - SAFE_MARGIN * 2) / 72;
  closeTo(ink.widthIn, innerW, '4x6 width');
  closeTo(ink.heightIn, innerW / 0.77, '4x6 height');
  assert.ok(ink.heightIn < innerH * 1.03);
  assert.ok(Math.abs(ink.leftIn - SAFE_MARGIN / 72) < 0.05, `4x6 left ${ink.leftIn.toFixed(3)}`);
  assert.ok(Math.abs(ink.topIn - SAFE_MARGIN / 72) < 0.05, `4x6 top ${ink.topIn.toFixed(3)}`);
  console.log(`4x6 ink ${ink.widthIn.toFixed(3)} x ${ink.heightIn.toFixed(3)} in at ${ink.leftIn.toFixed(3)}, ${ink.topIn.toFixed(3)}`);
  const decoded = await scan(await renderPng(outBytes).then((shot) => shot.png));
  assert.equal(decoded[0]?.number, TRACK);
});
