import type { SupabaseClient } from '@supabase/supabase-js';
import { buildLabelPdf, imageToLabelPdf, labelPaperName, type LabelPaper } from './labelSheet';
import { labelPrintKind } from './labelPrintKind';

export type AndroidPrintTab = { job: string; tab: Window | null };

function pdfCopy(bytes: Uint8Array) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

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

function bytesToBase64(bytes: Uint8Array) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      resolve(text.slice(text.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Could not prepare the label.'));
    reader.readAsDataURL(new Blob([pdfCopy(bytes)], { type: 'application/pdf' }));
  });
}

async function sharePdf(bytes: Uint8Array) {
  const file = new File([pdfCopy(bytes)], 'label.pdf', { type: 'application/pdf' });
  if (!navigator.canShare?.({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title: 'Shipping label' });
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return true;
    return false;
  }
}

function labelPageHtml(b64: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Print label</title>
<style>html,body{margin:0;background:#fff;color:#111;font:16px sans-serif}.bar{display:flex;gap:8px;padding:12px}button,a{flex:1;min-height:52px;font-size:18px;border-radius:10px;border:1px solid #111;background:#111;color:#fff;text-align:center;line-height:52px;text-decoration:none}a{background:#fff;color:#111}iframe{width:100%;height:calc(100vh - 88px);border:0;background:#fff}p{margin:0;padding:0 12px 8px}</style>
</head><body>
<div class="bar"><button type="button" id="print">Print</button><a id="back" href="/">Back</a></div>
<p>Tap Print and choose the printer.</p>
<iframe id="sheet" title="Shipping label"></iframe>
<script>
var b64 = ${JSON.stringify(b64)};
var bin = atob(b64);
var bytes = new Uint8Array(bin.length);
for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
var blob = new Blob([bytes], { type: 'application/pdf' });
var file = new File([blob], 'label.pdf', { type: 'application/pdf' });
document.getElementById('sheet').src = URL.createObjectURL(blob);
document.getElementById('back').addEventListener('click', function (event) {
  if (history.length > 1) { event.preventDefault(); history.back(); }
});
document.getElementById('print').addEventListener('click', function () {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'Shipping label' }).catch(function () { window.print(); });
    return;
  }
  window.print();
});
</script></body></html>`;
}

/** The installed app ignores window.print(). Hand the file to Android, which can open the printer. */
async function printOnAndroid(bytes: Uint8Array, started: AndroidPrintTab | null) {
  const shared = await sharePdf(bytes);
  if (shared) {
    started?.tab?.close();
    return;
  }
  const tab = started?.tab && !started.tab.closed ? started.tab : window.open('about:blank', '_blank');
  if (!tab) throw new Error('Could not open the printer.');
  const b64 = await bytesToBase64(bytes);
  tab.document.open();
  tab.document.write(labelPageHtml(b64));
  tab.document.close();
}

/** Open the PDF itself. Its page size is 4×6 or letter, so AirPrint and desktop print at that size. */
export async function printPdfBytes(bytes: Uint8Array, androidTab: AndroidPrintTab | null = null) {
  const kind = labelPrintKind(navigator.userAgent || '', navigator.maxTouchPoints || 0, navigator.platform || '');
  if (kind === 'android') {
    await printOnAndroid(bytes, androidTab);
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
  await printPdfBytes(new Uint8Array(await blob.arrayBuffer()), androidTab);
}
