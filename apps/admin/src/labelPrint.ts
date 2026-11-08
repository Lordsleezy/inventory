import { PDFDocument, degrees, type PDFEmbeddedPage, type PDFPage } from 'pdf-lib';

const PT = 72;
/** Shipping label, in PDF points. */
export const LABEL_W = 4 * PT;
export const LABEL_H = 6 * PT;
/** Letter sheet. The label is drawn at 4×6 on it so a letter printer does not blow it up. */
export const PAPER_W = 8.5 * PT;
export const PAPER_H = 11 * PT;
const TOP_GAP = 0.25 * PT;

export function fitLabelBox(srcW: number, srcH: number) {
  if (!(srcW > 0) || !(srcH > 0)) throw new Error('Label has no page size.');
  const scale = Math.min(LABEL_W / srcW, LABEL_H / srcH);
  return { scale, width: srcW * scale, height: srcH * scale };
}

function isPdf(bytes: Uint8Array, mime: string) {
  return mime.includes('pdf') || (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
}

function isPng(bytes: Uint8Array, mime: string) {
  return mime.includes('png') || (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50);
}

function placeBox(srcW: number, srcH: number) {
  const fit = fitLabelBox(srcW, srcH);
  const boxX = (PAPER_W - LABEL_W) / 2;
  const boxY = PAPER_H - TOP_GAP - LABEL_H;
  return {
    x: boxX + (LABEL_W - fit.width) / 2,
    y: boxY + (LABEL_H - fit.height) / 2,
    width: fit.width,
    height: fit.height,
  };
}

function letterPage(out: PDFDocument) {
  const page = out.addPage([PAPER_W, PAPER_H]);
  page.setMediaBox(0, 0, PAPER_W, PAPER_H);
  page.setCropBox(0, 0, PAPER_W, PAPER_H);
  page.setBleedBox(0, 0, PAPER_W, PAPER_H);
  page.setTrimBox(0, 0, PAPER_W, PAPER_H);
  page.setArtBox(0, 0, PAPER_W, PAPER_H);
  return page;
}

/** Corner ticks make the drawn area the full sheet, so a phone cannot blow the label up to fill the paper. */
function pinSheet(page: PDFPage) {
  const tick = 8;
  const m = 6;
  const marks: Array<[[number, number], [number, number]]> = [
    [[m, m], [m + tick, m]],
    [[m, m], [m, m + tick]],
    [[PAPER_W - m, m], [PAPER_W - m - tick, m]],
    [[PAPER_W - m, m], [PAPER_W - m, m + tick]],
    [[m, PAPER_H - m], [m + tick, PAPER_H - m]],
    [[m, PAPER_H - m], [m, PAPER_H - m - tick]],
    [[PAPER_W - m, PAPER_H - m], [PAPER_W - m - tick, PAPER_H - m]],
    [[PAPER_W - m, PAPER_H - m], [PAPER_W - m, PAPER_H - m - tick]],
  ];
  for (const [start, end] of marks) {
    page.drawLine({ start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] }, thickness: 0.5 });
  }
}

/** Place every source page, scaled up or down, inside a 4×6 inch box on a letter sheet. */
export async function normalizeLabelPdf(input: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = src.getPages();
  if (!pages.length) throw new Error('Label PDF has no pages.');
  const out = await PDFDocument.create();
  for (const srcPage of pages) {
    const embedded = await out.embedPage(srcPage);
    const page = letterPage(out);
    drawEmbedded(page, embedded, srcPage);
    pinSheet(page);
  }
  return out.save();
}

function drawEmbedded(page: PDFPage, embedded: PDFEmbeddedPage, srcPage: PDFPage) {
  const angle = ((srcPage.getRotation().angle % 360) + 360) % 360;
  const media = srcPage.getSize();
  const turned = angle === 90 || angle === 270;
  const box = placeBox(turned ? media.height : media.width, turned ? media.width : media.height);
  if (angle === 90) {
    page.drawPage(embedded, {
      x: box.x + box.width,
      y: box.y,
      width: box.height,
      height: box.width,
      rotate: degrees(90),
    });
    return;
  }
  if (angle === 270) {
    page.drawPage(embedded, {
      x: box.x,
      y: box.y + box.height,
      width: box.height,
      height: box.width,
      rotate: degrees(-90),
    });
    return;
  }
  if (angle === 180) {
    page.drawPage(embedded, {
      x: box.x + box.width,
      y: box.y + box.height,
      width: box.width,
      height: box.height,
      rotate: degrees(180),
    });
    return;
  }
  page.drawPage(embedded, box);
}

export async function imageToLabelPdf(bytes: Uint8Array, kind: 'png' | 'jpg'): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const image = kind === 'png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
  const page = letterPage(out);
  page.drawImage(image, placeBox(image.width, image.height));
  pinSheet(page);
  return out.save();
}

async function rasterToPng(bytes: Uint8Array, mime: string) {
  const blob = new Blob([bytes.slice()], { type: mime || 'image/png' });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read that label image.');
  ctx.drawImage(bitmap, 0, 0);
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((next) => (next ? resolve(next) : reject(new Error('Could not read that label image.'))), 'image/png');
  });
  return new Uint8Array(await png.arrayBuffer());
}

export async function labelFileToPrintPdf(input: Uint8Array | ArrayBuffer, mime = ''): Promise<Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const type = mime.toLowerCase();
  if (isPdf(bytes, type)) return normalizeLabelPdf(bytes);
  if (isPng(bytes, type)) return imageToLabelPdf(bytes, 'png');
  if (type.includes('jpeg') || type.includes('jpg') || (bytes[0] === 0xff && bytes[1] === 0xd8)) return imageToLabelPdf(bytes, 'jpg');
  return imageToLabelPdf(await rasterToPng(bytes, type), 'png');
}

export async function loadPrintableLabel(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load the label.');
  const mime = res.headers.get('content-type') || '';
  const bytes = new Uint8Array(await res.arrayBuffer());
  const pdf = await labelFileToPrintPdf(bytes, mime);
  return new Blob([pdf.slice()], { type: 'application/pdf' });
}

export async function openShippingLabel(url: string, download = false) {
  let blob: Blob;
  try {
    blob = await loadPrintableLabel(url);
  } catch {
    if (download) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.click();
      return;
    }
    window.open(url, '_blank', 'noopener');
    return;
  }
  const href = URL.createObjectURL(blob);
  if (download) {
    const a = document.createElement('a');
    a.href = href;
    a.download = 'label-4x6.pdf';
    a.click();
  } else {
    const opened = window.open(href, '_blank', 'noopener');
    if (!opened) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.click();
    }
  }
  window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
