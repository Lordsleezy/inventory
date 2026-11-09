import type { SupabaseClient } from '@supabase/supabase-js';
import { buildLabelPdf, imageToLabelPdf, labelPaperName, type LabelPaper } from './labelSheet';
import { androidPrintDocument, chromeLabelIntent, labelPrintKind } from './labelPrintKind';

export type AndroidPrintTab = { job: string; tab: Window | null };

function writeBuilding(tab: Window) {
  tab.document.open();
  tab.document.write('<!doctype html><title>Label</title><body style="margin:0;font:18px sans-serif;padding:24px">Building the label…</body>');
  tab.document.close();
}

/** Call this in the tap handler, before any await. The installed Android app cannot print itself. */
export function startAndroidPrint(): AndroidPrintTab | null {
  if (typeof navigator === 'undefined') return null;
  if (labelPrintKind(navigator.userAgent || '', navigator.maxTouchPoints || 0, navigator.platform || '') !== 'android') return null;
  const job = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const tab = window.open('about:blank', '_blank');
  if (tab) {
    try { writeBuilding(tab); } catch { /* filled in when the label is ready */ }
  }
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

function attr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function labelPngs(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const pngs: Blob[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not prepare the label.');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not prepare the label.'))), 'image/png');
    });
    pngs.push(png);
  }
  if (!pngs.length) throw new Error('Could not prepare the label.');
  return pngs;
}

/** The print page needs a normal image address. The installed app cannot open the printer itself. */
async function uploadPrintPngs(client: SupabaseClient, pngs: Blob[]) {
  const { data: storeId, error } = await client.rpc('portal_store_id');
  if (error || storeId == null || storeId === '') throw new Error('Could not prepare the label.');
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}`;
  const urls: string[] = [];
  for (let i = 0; i < pngs.length; i += 1) {
    const path = `${storeId}/print/${id}-${i}.png`;
    const up = await client.storage.from('order-labels').upload(path, pngs[i], {
      contentType: 'image/png',
      upsert: false,
    });
    if (up.error) throw new Error('Could not prepare the label.');
    const signed = await client.storage.from('order-labels').createSignedUrl(path, 600);
    if (signed.error || !signed.data?.signedUrl) throw new Error('Could not prepare the label.');
    urls.push(signed.data.signedUrl);
  }
  return urls;
}

function printerLinkPage(intent: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Print label</title>
<style>html,body{margin:0;background:#fff;color:#111;font:16px sans-serif}.bar{display:flex;gap:8px;padding:12px}a{flex:1;min-height:52px;font-size:18px;border-radius:10px;border:1px solid #111;background:#111;color:#fff;text-align:center;line-height:52px;text-decoration:none}a.back{background:#fff;color:#111}p{margin:0;padding:0 12px 12px}</style>
</head><body>
<div class="bar"><a id="print" href="${attr(intent)}">Print</a><a class="back" href="/">Back</a></div>
<p>Tap Print. The phone printer list opens.</p>
</body></html>`;
}

/** The installed app has no printer list. Open the label page that calls Android print. */
async function printOnAndroid(
  bytes: Uint8Array,
  started: AndroidPrintTab | null,
  host?: { client?: SupabaseClient; paper?: LabelPaper },
) {
  const tab = started?.tab && !started.tab.closed ? started.tab : window.open('about:blank', '_blank');
  if (!host?.client) {
    tab?.close();
    throw new Error('Could not open the printer.');
  }
  let intent = '';
  try {
    const pngs = await labelPngs(bytes);
    const urls = await uploadPrintPngs(host.client, pngs);
    const page = androidPrintDocument(window.location.origin, urls, host.paper || 'label');
    intent = chromeLabelIntent(page);
  } catch (error) {
    tab?.close();
    throw error instanceof Error ? error : new Error('Could not prepare the label.');
  }
  if (!intent || !tab) {
    tab?.close();
    throw new Error('Could not open the printer.');
  }
  tab.document.open();
  tab.document.write(printerLinkPage(intent));
  tab.document.close();
}

/** Open the PDF itself. Its page size is 4×6 or letter, so AirPrint and desktop print at that size. */
export async function printPdfBytes(
  bytes: Uint8Array,
  androidTab: AndroidPrintTab | null = null,
  host?: { client?: SupabaseClient; paper?: LabelPaper },
) {
  const kind = labelPrintKind(navigator.userAgent || '', navigator.maxTouchPoints || 0, navigator.platform || '');
  if (kind === 'android') {
    await printOnAndroid(bytes, androidTab, host);
    return;
  }
  const blob = new Blob([bytes.slice()], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const href = `${url}#zoom=100`;
  if (kind === 'ios') {
    const opened = window.open(href, '_blank');
    if (!opened) {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.click();
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
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
    URL.revokeObjectURL(url);
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
  await printPdfBytes(new Uint8Array(await blob.arrayBuffer()), androidTab, { client, paper });
}
