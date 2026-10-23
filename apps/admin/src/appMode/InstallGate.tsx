import { useEffect, useMemo, useState } from 'react';
import {
  dismissInstallGate,
  isAndroid,
  isIos,
  isIpad,
  isSafari,
} from './isAppMode';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type Props = { onContinue: () => void };

/** Full-screen “Get the Floor app” coach for phone browser tabs. */
export function InstallGate({ onContinue }: Props) {
  const ios = isIos();
  const android = isAndroid();
  const safari = isSafari();
  const ipad = isIpad();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onBip);
    return () => window.removeEventListener('beforeinstallprompt', onBip);
  }, []);

  const shareAtBottom = ios && !ipad;

  const steps = useMemo(() => {
    if (ios && safari) {
      return shareAtBottom
        ? ['Tap Share in the bar at the bottom', 'Tap Add to Home Screen', 'Tap Add']
        : ['Tap Share in the bar at the top', 'Tap Add to Home Screen', 'Tap Add'];
    }
    if (ios && !safari) {
      return ['Open this page in Safari', 'Tap Share → Add to Home Screen', 'Tap Add'];
    }
    if (android && deferred) {
      return ['Tap Install app below', 'Confirm Install'];
    }
    return ['Tap ⋮ in Chrome', 'Tap Add to Home screen or Install app', 'Confirm'];
  }, [ios, safari, android, deferred, shareAtBottom]);

  async function install() {
    if (!deferred) return;
    setBusy(true);
    try {
      await deferred.prompt();
      await deferred.userChoice;
      setDeferred(null);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.origin + '/');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  function continueBrowser() {
    dismissInstallGate();
    onContinue();
  }

  return (
    <div className="install-gate" role="dialog" aria-labelledby="install-gate-title">
      <div className="install-gate-inner">
        <img className="install-gate-icon" src="/icons/icon-192.png" alt="" width={88} height={88} />
        <h1 id="install-gate-title">Get the Floor app</h1>
        <p className="install-gate-lead">
          Add Floor to your home screen. It opens like a real app — faster, full screen, no browser chrome.
        </p>

        <ol className="install-gate-steps">
          {steps.map((s) => <li key={s}>{s}</li>)}
        </ol>

        {ios && safari && (
          <div className={`install-gate-arrow ${shareAtBottom ? 'bottom' : 'top'}`} aria-hidden>
            <span className="install-gate-arrow-label">Share</span>
            <svg viewBox="0 0 48 80" width="48" height="80">
              <path d="M24 8 v52" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
              <path d="M12 48 l12 16 l12 -16" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}

        {ios && !safari && (
          <div className="install-gate-actions">
            <button type="button" className="install-gate-primary" onClick={() => void copyLink()}>
              {copied ? 'Link copied' : 'Copy link'}
            </button>
            <p className="install-gate-hint">Paste it in Safari, then Add to Home Screen.</p>
          </div>
        )}

        {android && deferred && (
          <div className="install-gate-actions">
            <button type="button" className="install-gate-primary" disabled={busy} onClick={() => void install()}>
              Install app
            </button>
          </div>
        )}

        {android && !deferred && (
          <div className={`install-gate-arrow top`} aria-hidden>
            <span className="install-gate-arrow-label">⋮ menu</span>
            <svg viewBox="0 0 48 80" width="48" height="80">
              <path d="M24 72 v-52" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
              <path d="M12 32 l12 -16 l12 16" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}

        <button type="button" className="install-gate-continue" onClick={continueBrowser}>
          Open Floor app
        </button>
      </div>
    </div>
  );
}
