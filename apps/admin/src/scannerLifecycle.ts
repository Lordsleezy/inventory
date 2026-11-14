/** Own every stream, including one that resolves after the app has gone into the background. */
export function scannerLifecycle(doc: Document, win: Window, video?: HTMLVideoElement | null, onStop?: () => void) {
  // Start running even if the tab briefly reported hidden during mount (Android permission
  // dialogs). Visibility listeners still halt a live stream when the app backgrounds.
  let stopped = false;
  let stream: MediaStream | null = null;
  const stop = () => {
    const wasStopped = stopped;
    stopped = true;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    if (video) { video.pause(); video.srcObject = null; }
    const active = doc.activeElement as HTMLElement | null;
    active?.blur?.();
    doc.removeEventListener('visibilitychange', hidden);
    doc.removeEventListener('freeze', stop);
    win.removeEventListener('pagehide', stop);
    if (!wasStopped) onStop?.();
  };
  const hidden = () => { if (doc.visibilityState !== 'visible') stop(); };
  doc.addEventListener('visibilitychange', hidden);
  doc.addEventListener('freeze', stop);
  win.addEventListener('pagehide', stop);
  return {
    get stopped() { return stopped; },
    attach(next: MediaStream) {
      if (stopped || doc.visibilityState !== 'visible') { next.getTracks().forEach(track => track.stop()); stop(); return false; }
      stream = next; if (video) video.srcObject = next; return true;
    },
    stop,
  };
}
