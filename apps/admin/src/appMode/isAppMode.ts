import { isKioskShell } from '../kiosk';

const APP_MODE_KEY = 'floor_app_mode';

function isNativeCapacitor(): boolean {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    return Boolean(cap?.isNativePlatform?.());
  } catch {
    return false;
  }
}

/** Old sticky flag that forced the phone shell into ordinary tabs; cleared on every load. */
function clearLegacyAppFlag(): void {
  try { localStorage.removeItem(APP_MODE_KEY); } catch { /* ignore */ }
}

/** @deprecated The phone shell is decided by launch mode only; kept so old callers compile. */
export function enableAppShell(): void {
  clearLegacyAppFlag();
}

/**
 * True only when Floor was launched as an installed app: home-screen PWA (iOS/Android, display-mode
 * standalone/fullscreen or navigator.standalone), the store-phone kiosk WebView, or Capacitor.
 * Desktop and ordinary mobile-browser tabs always get the desktop layout — regardless of width,
 * role, URL params or anything saved earlier.
 */
export function isStandaloneApp(): boolean {
  if (typeof window === 'undefined') return false;
  clearLegacyAppFlag();
  if (isKioskShell() || isNativeCapacitor()) return true;
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
  } catch { /* ignore */ }
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Rough phone / small-tablet viewport — used for the install gate only. */
export function isPhoneViewport(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.matchMedia('(max-width: 900px)').matches && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return window.innerWidth <= 900;
  }
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent);
}

export function isSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isWebkit = /Safari/i.test(ua);
  // iOS Chrome has CriOS; real Safari does not.
  if (/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua)) return false;
  return isWebkit && !/Chrome|Chromium|Android/i.test(ua);
}

export function isIpad(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

const DISMISS_KEY = 'floor_install_dismissed_until';
const DISMISS_DAYS = 3;

export function installDismissed(): boolean {
  try {
    const until = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return until > Date.now();
  } catch {
    return false;
  }
}

export function dismissInstallGate(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000));
  } catch { /* ignore */ }
}

/**
 * Full-screen install coach — only for iOS Safari browser tabs that are not
 * already the installed Floor app. Store Android phone never sees this.
 */
export function shouldShowInstallGate(): boolean {
  if (isStandaloneApp()) return false;
  if (isKioskShell() || isNativeCapacitor()) return false;
  if (isAndroid()) return false;
  if (!isPhoneViewport()) return false;
  if (installDismissed()) return false;
  return true;
}
