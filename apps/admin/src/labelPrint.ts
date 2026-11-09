import type { SupabaseClient } from '@supabase/supabase-js';
import { buildLabelPdf, imageToLabelPdf, labelPaperName, type LabelPaper } from './labelSheet';
import { androidPrintPath, labelPrintKind } from './labelPrintKind';

export type AndroidPrintTab = { job: string; tab: Window | null };

const PRINT_PREFIX = 'floor-print-';

/** Call this in the tap handler, before any await. The installed Android app cannot print itself. */
export function startAndroidPrint(): AndroidPrintTab | null {
  if (typeof navigator === 'undefined') return null;
  if (labelPrintKind(navigator.userAgent || '', navigator.maxTouchPoints || 0, navigator.platform || '') !== 'android') return null;
  const job = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const tab = window.open(androidPrintPath(job), '_blank');
  return { job, tab };
}

const PAPER_KEY = 'floor-label-paper';

export function cachedLabelPaper(): LabelPaper {
  try {
    return labelPaperName(localStorage.getItem(PAPER_KEY));
  } catch {
    return 'label';
  }
}

export function rememberLabelPaper(paper: LabelPaper) {
  try { localStorage.setItem(PAPER_KEY, paper); } catch { /* private mode */ }
}

export async function refreshLabelPaper(client: SupabaseClient): Promise<LabelPaper> {
  const { data, error } = await client.rpc('portal_label_paper');
  if (error) return cachedLabelPaper();
  const paper = labelPaperName(data);
  rememberLabelPaper(paper);
  return paper;
}

export async function saveLabelPaper(client: SupabaseClient, paper: LabelPaper): Promise<LabelPaper> {
  const { data, error } = await client.rpc('portal_set_label_paper', { p_paper: paper });
  if (error) throw new Error('Could not save the label paper.');
  const saved = labelPaperName(data || paper);
  rememberLabelPaper(saved);
  return saved;
}

function isPdf(bytes: Uint8Array, mime: string) {
  return mime.includes('pdf') || (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
}

function isPng(bytes: Uint8Array, mime: string) {
  return mime.includes('png') || (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50);
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

export async function labelFileToPrintPdf(input: Uint8Array | ArrayBuffer, mime = '', paper: LabelPaper = 'label'): Promise<Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const type = mime.toLowerCase();
  if (isPdf(bytes, type)) return buildLabelPdf(bytes, paper);
  if (isPng(bytes, type)) return imageToLabelPdf(bytes, 'png', paper);
  if (type.includes('jpeg') || type.includes('jpg') || (bytes[0] === 0xff && bytes[1] === 0xd8)) return imageToLabelPdf(bytes, 'jpg', paper);
  return imageToLabelPdf(await rasterToPng(bytes, type), 'png', paper);
}

async function paperForPrint(client?: SupabaseClient): Promise<LabelPaper> {
  if (!client) return cachedLabelPaper();
  return refreshLabelPaper(client);
}

export async function loadPrintableLabel(url: string, paper: LabelPaper = cachedLabelPaper()) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load the label.');
  const mime = res.headers.get('content-type') || '';
  const bytes = new Uint8Array(await res.arrayBuffer());
  const pdf = await labelFileToPrintPdf(bytes, mime, paper);
  return new Blob([pdf.slice()], { type: 'application/pdf' });
}

async function labelPageImages(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const urls: string[] = [];
  let width = 288;
  let height = 432;
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const natural = page.getViewport({ scale: 1 });
    if (i === 1) {
      width = natural.width;
      height = natural.height;
    }
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not prepare the label.');
    await page.render({ canvasContext: ctx, viewport }).promise;
    urls.push(canvas.toDataURL('image/png'));
  }
  return { urls, width, height };
}

/** The installed Floor app cannot open Android's print dialog. A Chrome tab can. */
async function printOnAndroid(bytes: Uint8Array, started: AndroidPrintTab | null) {
  const images = await labelPageImages(bytes);
  const job = started?.job || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    localStorage.setItem(PRINT_PREFIX + job, JSON.stringify(images));
  } catch {
    started?.tab?.close();
    throw new Error('Could not prepare the label for printing.');
  }
  const tab = started?.tab;
  if (tab && !tab.closed) return;
  const opened = window.open(androidPrintPath(job), '_blank');
  if (opened) return;
  const path = `${location.host}${androidPrintPath(job)}`;
  const fallback = `${location.origin}${androidPrintPath(job)}`;
  const link = document.createElement('a');
  link.href = `intent://${path}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
  link.target = '_blank';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Open the PDF itself. Its page size is 4×6 or letter, so AirPrint and desktop print at that size. */
export async function printPdfBytes(bytes: Uint8Array, androidTab: AndroidPrintTab | null = null) {
  const kind = labelPrintKind(navigator.userAgent || '', navigator.maxTouchPoints || 0, navigator.platform || '');
  if (kind === 'android') {
    await printOnAndroid(bytes, androidTab);
    return;
  }
  const blob = new Blob([bytes.slice()], { type: 'application/pdf' });
  const href = URL.createObjectURL(blob);
  if (kind === 'ios') {
    const opened = window.open(href, '_blank');
    if (!opened) {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.click();
    }
    window.setTimeout(() => URL.revokeObjectURL(href), 120_000);
    return;
  }
  const frame = document.createElement('iframe');
  frame.title = 'Shipping label';
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  frame.src = href;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch { /* the PDF is still open in the frame */ }
  };
  document.body.appendChild(frame);
  window.setTimeout(() => {
    frame.remove();
    URL.revokeObjectURL(href);
  }, 120_000);
}

export async function openShippingLabel(url: string, download = false, client?: SupabaseClient, androidTab: AndroidPrintTab | null = null) {
  const paper = await paperForPrint(client);
  const blob = await loadPrintableLabel(url, paper);
  if (download) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = paper === 'letter' ? 'label-letter.pdf' : 'label-4x6.pdf';
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
    return;
  }
  await printPdfBytes(new Uint8Array(await blob.arrayBuffer()), androidTab);
}
