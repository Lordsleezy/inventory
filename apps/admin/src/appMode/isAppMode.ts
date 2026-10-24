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

function launchedAsApp(): boolean {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('app') === '1') return true;
    // manifest start_url is /?source=pwa
    if (q.get('source') === 'pwa') return true;
    if (q.get('kiosk') === '1') return true;
    return false;
  } catch {
    return false;
  }
}

/** Persist that this device should use the native app shell (store phone / installed PWA). */
export function enableAppShell(): void {
  try {
    localStorage.setItem(APP_MODE_KEY, '1');
  } catch { /* ignore */ }
}

export function appShellEnabled(): boolean {
  try {
    return localStorage.getItem(APP_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * True when this session should run the Floor phone app shell (not desktop chrome).
 * Store phone / kiosk / installed PWA / Capacitor — never the “Add to Home Screen” coach.
 */
export function isStandaloneApp(): boolean {
  if (typeof window === 'undefined') return false;

  // Store-phone Android kiosk WebView / FloorInventoryShell / ?kiosk=1
  if (isKioskShell()) {
    enableAppShell();
    return true;
  }
  if (isNativeCapacitor()) {
    enableAppShell();
    return true;
  }

  try {
    if (window.matchMedia('(display-mode: standalone)').matches) {
      enableAppShell();
      return true;
    }
    if (window.matchMedia('(display-mode: fullscreen)').matches) {
      enableAppShell();
      return true;
    }
    if (window.matchMedia('(display-mode: minimal-ui)').matches) {
      enableAppShell();
      return true;
    }
  } catch { /* ignore */ }

  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) {
    enableAppShell();
    return true;
  }

  // Manifest start_url uses ?source=pwa; ?app=1 / ?kiosk=1 for QA and store shell.
  if (launchedAsApp()) {
    enableAppShell();
    return true;
  }

  // Once this device has been used as the Floor app, stay in app mode.
  if (appShellEnabled()) return true;

  // Android store phone opens admin in Chrome — treat phone Chrome as the app,
  // not a browser tab that needs “Add to Home Screen”.
  if (isAndroid() && isPhoneViewport()) {
    enableAppShell();
    return true;
  }

  return false;
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
