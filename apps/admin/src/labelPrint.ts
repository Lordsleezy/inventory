import { PDFDocument, degrees, type PDFEmbeddedPage, type PDFPage } from 'pdf-lib';

const PT = 72;
/** Shipping label, in PDF points. */
export const LABEL_W = 4 * PT;
export const LABEL_H = 6 * PT;
/** Letter sheet. The label is drawn at 4×6 on it so a letter printer does not blow it up. */
export const PAPER_W = 8.5 * PT;
export const PAPER_H = 11 * PT;
export function fitLabelBox(srcW: number, srcH: number) {
  if (!(srcW > 0) || !(srcH > 0)) throw new Error('Label has no page size.');
  const scale = Math.min(LABEL_W / srcW, LABEL_H / srcH);
  return { scale, width: srcW * scale, height: srcH * scale };
}

/** Top-left corner of the sheet. One fold takes off the right side, one fold takes off the bottom. */
export function labelPlacement(srcW: number, srcH: number) {
  const fit = fitLabelBox(srcW, srcH);
  return { x: 0, y: PAPER_H - fit.height, width: fit.width, height: fit.height };
}

function isPdf(bytes: Uint8Array, mime: string) {
  return mime.includes('pdf') || (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
}

function isPng(bytes: Uint8Array, mime: string) {
  return mime.includes('png') || (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50);
}

function placeBox(srcW: number, srcH: number) {
  return labelPlacement(srcW, srcH);
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

/** Place every source page, scaled up or down, in the top-left corner of a letter sheet. */
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

const PRINT_ID = 'floor-label-print';
const PRINT_CSS = `
@page { size: 8.5in 11in; margin: 0; }
@media screen {
  #${PRINT_ID} { position: fixed !important; left: 0; top: 0; width: 8.5in; height: 11in; transform: translateX(-200vw); pointer-events: none; }
}
@media print {
  html, body { margin: 0 !important; padding: 0 !important; width: 8.5in !important; height: 11in !important; background: #fff !important; }
  body > *:not(#${PRINT_ID}) { display: none !important; }
  #${PRINT_ID} { display: block !important; position: absolute !important; left: 0 !important; top: 0 !important; transform: none !important; width: 8.5in !important; height: 11in !important; margin: 0 !important; padding: 0 !important; }
  #${PRINT_ID} img { width: 8.5in; height: 11in; display: block; object-fit: fill; object-position: left top; break-after: page; page-break-after: always; }
  #${PRINT_ID} img:last-child { break-after: auto; page-break-after: auto; }
}
`;

async function pageImages(pdfBytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: pdfBytes.slice() }).promise;
  const urls: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 200 / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not prepare the label.');
    await page.render({ canvasContext: ctx, viewport }).promise;
    urls.push(canvas.toDataURL('image/png'));
  }
  return urls;
}

function waitForImage(img: HTMLImageElement) {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not prepare the label.'));
  });
}

/** Draw the letter sheet and open the phone print dialog. Stays in the app. No share page. */
async function printLetterSheet(pdfBytes: Uint8Array) {
  const urls = await pageImages(pdfBytes);
  document.getElementById(PRINT_ID)?.remove();
  const root = document.createElement('div');
  root.id = PRINT_ID;
  for (const href of urls) {
    const img = document.createElement('img');
    img.src = href;
    img.alt = 'Shipping label';
    root.appendChild(img);
  }
  document.body.appendChild(root);
  let style = document.getElementById('floor-label-print-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'floor-label-print-style';
    style.textContent = PRINT_CSS;
    document.head.appendChild(style);
  }
  await Promise.all(Array.from(root.querySelectorAll('img'), (img) => waitForImage(img)));
  window.print();
  window.setTimeout(() => root.remove(), 120_000);
}

export async function openShippingLabel(url: string, download = false) {
  const blob = await loadPrintableLabel(url);
  if (download) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = 'label-4x6.pdf';
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
    return;
  }
  await printLetterSheet(new Uint8Array(await blob.arrayBuffer()));
}
