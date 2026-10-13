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

/** Prefer physical/HID keyboard; soft keyboard stays hidden in the shell. */
export function scannerInputMode(): 'none' | 'search' | 'numeric' | 'decimal' {
  return isKioskShell() ? 'none' : 'search';
}
