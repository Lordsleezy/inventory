import { PDFDocument, degrees, type PDFEmbeddedPage, type PDFPage } from 'pdf-lib';

const PT = 72;
/** Shipping label, in PDF points. 4in × 6in. */
export const LABEL_W = 4 * PT;
export const LABEL_H = 6 * PT;
export const LETTER_W = 8.5 * PT;
export const LETTER_H = 11 * PT;
/** Top-left quarter of a letter sheet. 4.25in × 5.5in. */
export const QUARTER_W = 4.25 * PT;
export const QUARTER_H = 5.5 * PT;
/** Kept off the edge of the paper and off the cut. */
export const SAFE_MARGIN = 0.1 * PT;
const NEAR = 12;

export type LabelPaper = 'label' | 'letter';

export function labelPaperName(value: unknown): LabelPaper {
  return value === 'letter' ? 'letter' : 'label';
}

type Box = { x0: number; y0: number; x1: number; y1: number };

type Measure = {
  box: Box;
  /** Extra counterclockwise degrees so the label is upright on the page. */
  rotate: number;
  /** Unrotated clip width and height. */
  width: number;
  height: number;
};

function emptyBox(): Box {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

function okBox(box: Box) {
  return box.x1 > box.x0 + 1 && box.y1 > box.y0 + 1;
}

function addPoint(box: Box, x: number, y: number) {
  box.x0 = Math.min(box.x0, x);
  box.y0 = Math.min(box.y0, y);
  box.x1 = Math.max(box.x1, x);
  box.y1 = Math.max(box.y1, y);
}

function transformPoint(m: number[], x: number, y: number) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function mul(m: number[], n: number[]) {
  const [a, b, c, d, e, f] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}

function area(box: Box) {
  return Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
}

function overlaps(a: Box, b: Box, gap: number) {
  return !(a.x1 + gap < b.x0 || b.x1 + gap < a.x0 || a.y1 + gap < b.y0 || b.y1 + gap < a.y0);
}

function union(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function clusterBoxes(boxes: Box[], gap: number): Box[] {
  const items = boxes.filter(okBox);
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (overlaps(items[i], items[j], gap)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Box>();
  items.forEach((box, i) => {
    const id = find(i);
    const prev = groups.get(id);
    groups.set(id, prev ? union(prev, box) : box);
  });
  return [...groups.values()].sort((a, b) => area(b) - area(a));
}

/** Pull address blocks that sit under a barcode instead of leaving them off the page. */
function expandColumn(seed: Box, pieces: Box[]): Box {
  let cluster = seed;
  let changed = true;
  while (changed) {
    changed = false;
    for (const box of pieces) {
      const xOverlap = !(cluster.x1 + 24 < box.x0 || box.x1 + 24 < cluster.x0);
      const yNear = !(cluster.y1 + 252 < box.y0 || box.y1 + 252 < cluster.y0);
      if (!xOverlap || !yNear) continue;
      const next = union(cluster, box);
      if (area(next) > area(cluster) + 1) {
        cluster = next;
        changed = true;
      }
    }
  }
  return cluster;
}

function nearly(a: number, b: number) {
  return Math.abs(a - b) <= NEAR;
}

async function loadPdfJs() {
  if (typeof document === 'undefined') {
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

async function measurePage(bytes: Uint8Array, pageIndex: number): Promise<Measure> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const view = page.view;
  const mediaW = view[2] - view[0];
  const mediaH = view[3] - view[1];
  const op = await page.getOperatorList();
  const text = await page.getTextContent();
  const OPS = pdfjs.OPS as Record<string, number>;
  const imageOps = new Set(
    ['paintImageXObject', 'paintImageXObjectRepeat', 'paintJpegXObject', 'paintImageMaskXObject', 'paintInlineImageXObject']
      .map((name) => OPS[name])
      .filter((n) => typeof n === 'number'),
  );
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const pieces: Box[] = [];
  let textX = 0;
  let textY = 0;
  let textWeight = 0;
  let imageX = 0;
  let imageY = 0;
  let imageWeight = 0;

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
        const box = emptyBox();
        for (const [x, y] of [[minMax[0], minMax[1]], [minMax[2], minMax[3]]] as number[][]) {
          const [px, py] = transformPoint(ctm, Number(x), Number(y));
          addPoint(box, px, py);
        }
        if (area(box) > 4) pieces.push(box);
      }
    } else if (imageOps.has(fn)) {
      const box = emptyBox();
      for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const [px, py] = transformPoint(ctm, x, y);
        addPoint(box, px, py);
      }
      if (area(box) > 4) {
        pieces.push(box);
        const len = Math.hypot(ctm[0], ctm[1]) || 1;
        const weight = area(box);
        imageX += (ctm[0] / len) * weight;
        imageY += (ctm[1] / len) * weight;
        imageWeight += weight;
      }
    }
  }

  for (const item of text.items) {
    if (!('str' in item) || !String(item.str).trim() || !item.transform) continue;
    const [a, b, c, d, e, f] = item.transform;
    const len = Math.hypot(a, b) || 1;
    const ux = a / len;
    const uy = b / len;
    const w = Number(item.width || 0);
    const h = Number(item.height || Math.hypot(c, d) || 0);
    const box = emptyBox();
    for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) {
      addPoint(box, e + ux * x - uy * y, f + uy * x + ux * y);
    }
    if (okBox(box)) pieces.push(box);
    const weight = Math.max(1, String(item.str).length);
    textX += (a / len) * weight;
    textY += (b / len) * weight;
    textWeight += weight;
  }

  const full: Box = { x0: 0, y0: 0, x1: mediaW, y1: mediaH };
  const usable = pieces.filter((box) => okBox(box) && area(box) < area(full) * 0.88);
  // A 4×6 file is the label. Keep every mark on it so the address is not cropped off.
  const ink = isLabelPage(mediaW, mediaH)
    ? (usable.reduce<Box | null>((acc, box) => (acc ? union(acc, box) : box), null) || full)
    : (labelFrame(usable, full) || full);
  const box = {
    x0: Math.max(0, ink.x0 - 2),
    y0: Math.max(0, ink.y0 - 2),
    x1: Math.min(mediaW, ink.x1 + 2),
    y1: Math.min(mediaH, ink.y1 + 2),
  };
  const angleX = textWeight > 0 ? textX : imageX;
  const angleY = textWeight > 0 ? textY : imageY;
  const angleWeight = textWeight > 0 ? textWeight : imageWeight;
  let textAngle = 0;
  if (angleWeight > 0) textAngle = Math.atan2(angleY, angleX) * 180 / Math.PI;
  const snapped = Math.round(((textAngle % 360) + 360) % 360 / 90) * 90 % 360;
  let rotate = (360 - snapped) % 360;
  if (rotate === 0 && mediaW > mediaH && isLabelPage(mediaW, mediaH)) rotate = 90;
  return { box, rotate, width: box.x1 - box.x0, height: box.y1 - box.y0 };
}

function isLabelPage(w: number, h: number) {
  return (nearly(w, LABEL_W) && nearly(h, LABEL_H)) || (nearly(w, LABEL_H) && nearly(h, LABEL_W));
}

function isFullLabel(box: Box) {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  return Math.min(w, h) >= 3.2 * 72 && Math.max(w, h) >= 4.5 * 72;
}

/**
 * The label on a letter sheet, not the blank paper around it and not the barcode alone.
 * A real label border wins. A short header still picks up the address underneath it.
 */
function labelFrame(pieces: Box[], full: Box): Box | null {
  const pageArea = area(full);
  const pageW = full.x1 - full.x0;
  const pageH = full.y1 - full.y0;
  if (!pieces.length) return null;
  const frames = pieces.filter((box) => {
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    const ratio = w / Math.max(h, 1);
    const labelSized = w > pageW * 0.28 && h > pageH * 0.28;
    return labelSized && area(box) > 50 * 50 && ratio > 0.45 && ratio < 1.85;
  }).sort((a, b) => area(b) - area(a));
  let chosen = frames[0] || null;
  if (chosen) chosen = pieces.filter((box) => overlaps(box, chosen as Box, 8)).reduce(union, chosen);
  else chosen = clusterBoxes(pieces, 48)[0] || null;
  if (!chosen) return null;
  if (!isFullLabel(chosen)) chosen = expandColumn(chosen, pieces);
  if (area(chosen) > pageArea * 0.82) return full;
  return chosen;
}

function finishPage(page: PDFPage, w: number, h: number) {
  page.setMediaBox(0, 0, w, h);
  page.setCropBox(0, 0, w, h);
  page.setBleedBox(0, 0, w, h);
  page.setTrimBox(0, 0, w, h);
  page.setArtBox(0, 0, w, h);
}

type Placed = { pageW: number; pageH: number; x: number; y: number; dw: number; dh: number };

/**
 * Letter: a full label fills the top-left quarter and may run past 5.5in
 * so a 4×6 is not squeezed down to about 3.5×5.3. It still stays on the sheet.
 * 4×6: fit the label on the label page without clipping.
 */
function placement(visW: number, visH: number, paper: LabelPaper): Placed {
  const margin = SAFE_MARGIN;
  if (paper === 'letter') {
    const quarterW = QUARTER_W - margin * 2;
    const quarterH = QUARTER_H - margin * 2;
    const pageInnerW = LETTER_W - margin * 2;
    const pageInnerH = LETTER_H - margin * 2;
    const contain = Math.min(quarterW / visW, quarterH / visH);
    const cover = Math.max(quarterW / visW, quarterH / visH);
    const fitPage = Math.min(pageInnerW / visW, pageInnerH / visH);
    const fullLabel = Math.min(visW, visH) >= 2.5 * 72 && Math.max(visW, visH) >= 3.5 * 72;
    const scale = Math.min(fullLabel ? cover : contain, fitPage);
    const dw = visW * scale;
    const dh = visH * scale;
    return { pageW: LETTER_W, pageH: LETTER_H, x: margin, y: LETTER_H - margin - dh, dw, dh };
  }
  const maxW = LABEL_W - margin * 2;
  const maxH = LABEL_H - margin * 2;
  const scale = Math.min(maxW / visW, maxH / visH);
  const dw = visW * scale;
  const dh = visH * scale;
  return { pageW: LABEL_W, pageH: LABEL_H, x: margin, y: margin + (maxH - dh), dw, dh };
}

function drawUpright(
  page: PDFPage,
  embedded: PDFEmbeddedPage,
  clipW: number,
  clipH: number,
  rotate: number,
  placed: Placed,
) {
  const angle = ((rotate % 360) + 360) % 360;
  const { x, y, dw, dh } = placed;
  if (angle === 90) {
    page.drawPage(embedded, { x: x + dw, y, width: dh, height: dw, rotate: degrees(90) });
    return;
  }
  if (angle === 270) {
    page.drawPage(embedded, { x, y: y + dh, width: dh, height: dw, rotate: degrees(-90) });
    return;
  }
  if (angle === 180) {
    page.drawPage(embedded, { x: x + dw, y: y + dh, width: dw, height: dh, rotate: degrees(180) });
    return;
  }
  page.drawPage(embedded, { x, y, width: dw, height: dh });
}

/** Crop, rotate upright, and place the label. The stored file is not changed. */
export async function buildLabelPdf(input: Uint8Array | ArrayBuffer, paper: LabelPaper = 'label'): Promise<Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = src.getPages();
  if (!pages.length) throw new Error('Label PDF has no pages.');
  const out = await PDFDocument.create();
  for (let i = 0; i < pages.length; i += 1) {
    const srcPage = pages[i];
    const measured = await measurePage(bytes, i);
    const rotate = measured.rotate;
    const embedded = await out.embedPage(srcPage, {
      left: measured.box.x0,
      bottom: measured.box.y0,
      right: measured.box.x1,
      top: measured.box.y1,
    });
    const angle = ((rotate % 360) + 360) % 360;
    const turned = angle === 90 || angle === 270;
    const placed = placement(turned ? measured.height : measured.width, turned ? measured.width : measured.height, paper);
    const page = out.addPage([placed.pageW, placed.pageH]);
    finishPage(page, placed.pageW, placed.pageH);
    drawUpright(page, embedded, measured.width, measured.height, rotate, placed);
  }
  return out.save();
}

export async function imageToLabelPdf(bytes: Uint8Array, kind: 'png' | 'jpg', paper: LabelPaper = 'label'): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const image = kind === 'png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
  const landscape = image.width > image.height * 1.05;
  const visW = landscape ? image.height : image.width;
  const visH = landscape ? image.width : image.height;
  const fit = placement(visW, visH, paper);
  const page = out.addPage([fit.pageW, fit.pageH]);
  finishPage(page, fit.pageW, fit.pageH);
  if (landscape) {
    page.drawImage(image, { x: fit.x + fit.dw, y: fit.y, width: fit.dh, height: fit.dw, rotate: degrees(90) });
  } else {
    page.drawImage(image, { x: fit.x, y: fit.y, width: fit.dw, height: fit.dh });
  }
  return out.save();
}
