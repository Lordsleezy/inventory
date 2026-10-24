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
 * with focusScannerField() instead.
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
 * Focus a scanner field without opening Android's soft keyboard, while still
 * accepting HID / Bluetooth wedge keystrokes.
 *
 * Trick: focus while briefly readOnly, then clear readOnly on the next frame.
 * Do not use inputMode="none" — that freezes Gboard phone-wide until reboot.
 *
 * Pass softKeyboard=true after an explicit user tap when typing is wanted.
 */
export function focusScannerField(
  el: HTMLInputElement | null | undefined,
  opts?: { softKeyboard?: boolean },
): void {
  if (!el) return;
  if (opts?.softKeyboard || !scannerFieldStartsReadOnly()) {
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
