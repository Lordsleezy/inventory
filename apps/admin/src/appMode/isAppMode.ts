/** True when launched from the home-screen installed app (or ?app=1 for local QA). */
export function isStandaloneApp(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
  } catch { /* ignore */ }
  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  // Local / preview override for screenshots and QA (does not affect normal phone tabs).
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('app') === '1') return true;
  } catch { /* ignore */ }
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
  const isChrome = /CriOS|Chrome|Chromium|EdgiOS|FxiOS|OPR|Edg/i.test(ua)
    && !/Safari\/[\d.]+$/i.test(ua.split(' ').pop() || '');
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

/** Show the full-screen install coach only on phones in a browser tab. */
export function shouldShowInstallGate(): boolean {
  if (isStandaloneApp()) return false;
  if (!isPhoneViewport()) return false;
  if (installDismissed()) return false;
  return true;
}
