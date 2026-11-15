/** Store-phone only. The installed Android app draws two controls the desktop never shows. */

export type FloaterBox = { top: number; right: number; bottom: number; left: number; width: number; height: number };

const NAMED = /scanner|keyboard|connecting|typing-pad|⌨/i;

export function shouldRemoveStorePhoneControl(input: {
  position: string;
  box: FloaterBox;
  viewport: { width: number; height: number };
  text: string;
  className: string;
  kept: boolean;
}): boolean {
  if (input.kept) return false;
  const text = input.text.replace(/\s+/g, ' ').trim();
  if (text.length > 60) return false;
  const named = NAMED.test(`${input.className} ${text}`);
  const floating = input.position === 'fixed' || input.position === 'absolute' || input.position === 'sticky';
  const corner = input.box.right >= input.viewport.width - 24
    && input.box.bottom >= input.viewport.height - 180
    && input.box.top <= input.viewport.height - 64
    && input.box.width >= 28
    && input.box.width <= 220
    && input.box.height >= 28
    && input.box.height <= 96;
  if (named && (floating || corner)) return true;
  return floating && corner && input.box.width <= 84 && input.box.height <= 84 && text.length <= 24;
}

const KEEP = '.app-tabbar, .receive-scanner, .install-gate, [role="dialog"]';

export function removeStorePhoneCornerControls(doc: Document): number {
  const view = doc.defaultView;
  if (!view) return 0;
  const viewport = { width: view.innerWidth, height: view.innerHeight };
  let removed = 0;
  const nodes = doc.body.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="status"]');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const style = view.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!shouldRemoveStorePhoneControl({
      position: style.position,
      box: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height },
      viewport,
      text: `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`,
      className: typeof el.className === 'string' ? el.className : '',
      kept: Boolean(el.closest(KEEP)),
    })) continue;
    el.remove();
    removed += 1;
  }
  return removed;
}
