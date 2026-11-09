export type LabelPrintKind = 'ios' | 'android' | 'frame';

/** Android Chrome ignores print() on a hidden PDF frame, so the phone prints from the orders page. */
export function labelPrintKind(ua = '', touchPoints = 0, platform = ''): LabelPrintKind {
  if (/iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && touchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'frame';
}
