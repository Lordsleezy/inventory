import { selectCdtfaPages } from './cdtfaPages';
import { trimCdtfaPdfBytes } from './cdtfaPdf';

const PRINT_ID = 'floor-cdtfa-print';
const PRINT_CSS = `
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body > *:not(#${PRINT_ID}) { display: none !important; }
  #${PRINT_ID} { display: block !important; }
  #${PRINT_ID} img { width: 8.5in; height: 11in; display: block; object-fit: fill; break-after: page; page-break-after: always; }
  #${PRINT_ID} img:last-child { break-after: auto; page-break-after: auto; }
}
`;

export async function cdtfaPageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  return texts;
}

/** Filled official form, cut down to the pages this period needs. */
export async function officialCdtfaPdf(filled: Uint8Array, districtTax: number) {
  const texts = await cdtfaPageTexts(filled);
  const plan = selectCdtfaPages(texts, districtTax);
  if (plan.warning) return { bytes: filled, pageCount: texts.length, warning: plan.warning };
  return { bytes: await trimCdtfaPdfBytes(filled, plan.keep), pageCount: plan.keep.length, warning: null as string | null };
}

async function pageImages(pdfBytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: pdfBytes.slice() }).promise;
  const urls: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.4 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not prepare the return.');
    await page.render({ canvasContext: ctx, viewport }).promise;
    urls.push(canvas.toDataURL('image/png'));
  }
  return urls;
}

/** Open the print dialog on the official pages, one sheet per page. */
export async function printCdtfaPages(pdfBytes: Uint8Array) {
  const urls = await pageImages(pdfBytes);
  document.getElementById(PRINT_ID)?.remove();
  const root = document.createElement('div');
  root.id = PRINT_ID;
  for (const href of urls) {
    const img = document.createElement('img');
    img.src = href;
    img.alt = 'CDTFA-401-A page';
    root.appendChild(img);
  }
  document.body.appendChild(root);
  let style = document.getElementById('floor-cdtfa-print-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'floor-cdtfa-print-style';
    style.textContent = PRINT_CSS;
    document.head.appendChild(style);
  }
  await Promise.all(Array.from(root.querySelectorAll('img'), (img) => img.decode().catch(() => undefined)));
  window.print();
  window.setTimeout(() => root.remove(), 120_000);
}
