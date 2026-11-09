export type LabelPrintKind = 'ios' | 'android' | 'frame';

/** Android Chrome ignores print() on a hidden PDF frame, so that phone uses the system print dialog. */
export function androidPrintPath(job: string) {
  return `/label-print.html?job=${encodeURIComponent(job)}`;
}

/** Open an https label in the Chrome app. The installed Floor app cannot show the print dialog. */
export function chromeLabelIntent(httpsUrl: string) {
  let url: URL;
  try { url = new URL(httpsUrl); } catch { return ''; }
  if (url.protocol !== 'https:') return '';
  url.hash = '';
  const rest = url.href.replace(/^https:\/\//i, '');
  return `intent://${rest}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
}

export function labelPrintKind(ua = '', touchPoints = 0, platform = ''): LabelPrintKind {
  if (/iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && touchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'frame';
}
