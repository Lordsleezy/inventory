/** True when opened inside the store-phone Inventory WebView shell (?kiosk=1 or data-floor-kiosk). */
export function isKioskShell(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if (document.documentElement.getAttribute('data-floor-kiosk') === '1') return true;
    if (document.documentElement.classList.contains('floor-kiosk-shell')) return true;
    if (/FloorInventoryShell/i.test(navigator.userAgent)) return true;
    const q = new URLSearchParams(window.location.search);
    return q.get('kiosk') === '1';
  } catch {
    return false;
  }
}

function isAndroidUa(): boolean {
  try {
    return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/**
 * Store Android phone (kiosk WebView, PWA, or coarse phone Chrome).
 * Soft-keyboard focus thrash on these devices can freeze Gboard system-wide
 * until the phone is power-cycled — avoid inputMode="none" + programmatic focus.
 */
export function isAndroidStoreDevice(): boolean {
  if (!isAndroidUa()) return false;
  if (isKioskShell()) return true;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return true;
  }
}

/**
 * Soft keyboard hint for scanner/search fields.
 *
 * Never returns "none". Focusing an inputMode=none field on Android Chrome/WebView
 * is a known way to wedge the system IME until reboot.
 */
export function scannerInputMode(): 'search' | 'numeric' | 'decimal' | undefined {
  if (isKioskShell() || isAndroidStoreDevice()) return undefined;
  return 'search';
}

/** True when scanner fields should avoid opening the soft keyboard on focus. */
export function scannerFieldStartsReadOnly(): boolean {
  return isKioskShell() || isAndroidStoreDevice();
}

/**
 * Focus a scanner field. On Android store phones this is a **no-op** unless
 * softKeyboard=true (explicit user tap). Prefer bindHidWedgeListener for wedges.
 */
export function focusScannerField(
  el: HTMLInputElement | null | undefined,
  opts?: { softKeyboard?: boolean },
): void {
  if (!el) return;
  if (opts?.softKeyboard) {
    try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    return;
  }
  // Never programmatically focus on Android — freezes Gboard until reboot.
  if (isAndroidStoreDevice()) return;
  if (!scannerFieldStartsReadOnly()) {
    try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    return;
  }
  const prev = el.readOnly;
  el.readOnly = true;
  try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
  requestAnimationFrame(() => {
    el.readOnly = prev;
  });
}

/**
 * Focus an editable field from a real user gesture (touch/click) only.
 * Never call from useEffect / timers — that wedges Gboard on store phones.
 */
export function focusFromUserGesture(el: HTMLElement | null | undefined): void {
  if (!el || typeof (el as HTMLInputElement).focus !== 'function') return;
  try {
    (el as HTMLInputElement).focus({ preventScroll: true });
  } catch {
    try { (el as HTMLInputElement).focus(); } catch { /* ignore */ }
  }
}

export type HidWedgeHandlers = {
  /** When false, keystrokes are ignored (form open, modal, user typing, etc.). */
  active: () => boolean;
  onScan: (code: string) => void;
};

/**
 * Capture Bluetooth / HID wedge keystrokes at the window.
 *
 * Important: do **not** preventDefault on every digit — that fights Gboard and can
 * leave the soft keyboard dead for the rest of the session (including manual entry).
 * We only stopPropagation/preventDefault on the terminating Enter when we accept a scan.
 */
export function bindHidWedgeListener(handlers: HidWedgeHandlers): () => void {
  let buf = '';
  let lastAt = 0;
  let resetTimer: number | undefined;
  const RESET_MS = 450;

  const clearBuf = () => {
    buf = '';
    if (resetTimer !== undefined) {
      window.clearTimeout(resetTimer);
      resetTimer = undefined;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (!handlers.active()) return;
    if (e.defaultPrevented || e.isComposing) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const t = e.target;
    if (t instanceof HTMLElement) {
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
        // Never steal keystrokes from a real form field the associate is typing in.
        if (t.getAttribute('data-hid-wedge') !== '1') return;
      }
    }

    const now = Date.now();
    if (now - lastAt > RESET_MS) buf = '';
    lastAt = now;

    if (e.key === 'Enter') {
      if (!buf) return;
      e.preventDefault();
      e.stopPropagation();
      const code = buf;
      clearBuf();
      handlers.onScan(code);
      return;
    }

    if (e.key.length === 1 && /[0-9A-Za-z\-]/.test(e.key)) {
      buf += e.key;
      // No preventDefault — keeps Gboard usable for the next Price / Brand tap.
      if (resetTimer !== undefined) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(clearBuf, RESET_MS);
    }
  };

  window.addEventListener('keydown', onKey, true);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    clearBuf();
  };
}
