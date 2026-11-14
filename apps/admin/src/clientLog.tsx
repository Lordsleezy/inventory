import { useEffect } from 'react';
import { floorFunctionUrl } from './floorApi';
import { FLOOR_BUILD_SHA } from './buildInfo';

export type ClientErrorInfo = {
  message: string;
  stack?: string;
  page?: string;
  screen?: string;
  status?: number | null;
  traceId?: string | null;
  sku?: string;
  action_name?: string;
};

function clientContext() {
  return {
    build: FLOOR_BUILD_SHA,
    screen: typeof location !== 'undefined' ? (location.hash || location.pathname) : '',
    device: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
}

/** Fire-and-forget: tell the backend about a failure the browser saw, so it shows up on the Logs page. */
export function reportClientError(token: string, info: ClientErrorInfo) {
  try {
    void fetch(floorFunctionUrl('portal-logs'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'client_error', url: location.href.split('#')[0], ...clientContext(), ...info }),
      keepalive: true,
    }).catch(() => undefined);
  } catch { /* reporting must never break the page */ }
}

/** Catches uncaught errors and unhandled promise failures anywhere in the portal. */
export function ClientErrorReporter({ token }: { token: string }) {
  useEffect(() => {
    const seen = new Set<string>();
    const send = (message: string, stack?: string) => {
      if (!message || seen.has(message) || seen.size >= 10) return;
      seen.add(message);
      reportClientError(token, { message, stack, page: location.hash || 'portal', screen: location.hash || location.pathname });
    };
    const onError = (e: ErrorEvent) => send(e.message || 'script error', e.error instanceof Error ? e.error.stack : '');
    const onRejection = (e: PromiseRejectionEvent) => send(
      e.reason instanceof Error ? e.reason.message : String(e.reason),
      e.reason instanceof Error ? e.reason.stack : '',
    );
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, [token]);
  return null;
}
