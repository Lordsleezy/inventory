export type LabelPrintKind = 'ios' | 'android' | 'frame';

/** Android Chrome ignores print() on a hidden PDF frame, so that phone uses the system print dialog. */
export function androidPrintPath(job: string) {
  return `/label-print.html?job=${encodeURIComponent(job)}`;
}

/** Page that draws the label and calls the phone printer. The file itself is not the page. */
export function androidPrintDocument(origin: string, sources: string[], paper: string) {
  const page = new URL('/label-print.html', origin);
  for (const src of sources) {
    if (/^https:\/\//i.test(src)) page.searchParams.append('src', src);
  }
  page.searchParams.set('paper', paper === 'letter' ? 'letter' : 'label');
  return page.href;
}

/**
 * Leave the installed app for a normal browser page.
 * That page calls print(), which is Android's printer list. A PDF address is not a web page.
 */
export function chromeLabelIntent(httpsUrl: string) {
  let url: URL;
  try { url = new URL(httpsUrl); } catch { return ''; }
  if (url.protocol !== 'https:') return '';
  url.hash = '';
  const rest = url.href.replace(/^https:\/\//i, '');
  return `intent://${rest}#Intent;scheme=https;package=com.android.chrome;category=android.intent.category.BROWSABLE;end`;
}

export function labelPrintKind(ua = '', touchPoints = 0, platform = ''): LabelPrintKind {
  if (/iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && touchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'frame';
}
