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
 * is a known way to wedge the system IME until reboot. Suppress the soft keyboard
 * with focusScannerField() / bindHidWedgeListener instead.
 */
export function scannerInputMode(): 'search' | 'numeric' | 'decimal' | undefined {
  if (isKioskShell() || isAndroidStoreDevice()) return undefined;
  return 'search';
}

/** True when scanner fields should avoid opening the soft keyboard on focus. */
export function scannerFieldStartsReadOnly(): boolean {
  return isKioskShell() || isAndroidStoreDevice();
}

/** Drop focus so the next tap can open Gboard cleanly. */
export function blurActiveInput(): void {
  try {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el !== document.body && typeof el.blur === 'function') {
      el.blur();
    }
  } catch {
    /* ignore */
  }
}

/**
 * Focus a scanner field without opening Android's soft keyboard, while still
 * accepting HID / Bluetooth wedge keystrokes on non-Android.
 *
 * On Android store phones this is a **no-op** unless softKeyboard=true (explicit
 * user tap). Programmatic focus still wedges Gboard until reboot on these phones —
 * use bindHidWedgeListener() for Bluetooth scanners instead.
 */
export function focusScannerField(
  el: HTMLInputElement | null | undefined,
  opts?: { softKeyboard?: boolean },
): void {
  if (!el) return;
  if (opts?.softKeyboard) {
    el.focus({ preventScroll: true });
    return;
  }
  if (isAndroidStoreDevice()) return;
  if (!scannerFieldStartsReadOnly()) {
    el.focus({ preventScroll: true });
    return;
  }
  const prev = el.readOnly;
  el.readOnly = true;
  el.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    el.readOnly = prev;
  });
}

export type HidWedgeHandlers = {
  /** When false, keystrokes are ignored (form open, modal, user typing, etc.). */
  active: () => boolean;
  onScan: (code: string) => void;
};

/**
 * Capture Bluetooth / HID wedge keystrokes at the window so Android never needs
 * a focused scan input (focused scan inputs are what freeze Gboard).
 *
 * Scanners send rapid alphanumerics then Enter. Typing into a normal INPUT /
 * TEXTAREA is left alone unless that element has data-hid-wedge="1".
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
      e.preventDefault();
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
