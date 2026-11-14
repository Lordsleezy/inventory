import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { scannerLifecycle } from './scannerLifecycle';
import { normalizeUpc } from './upcValidate';

const FORMATS = ['UPC-A', 'UPC-E', 'EAN-13', 'EAN-8'] as const;

function checkDigitOk(code: string) {
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(code[i]) * weight;
  }
  return Number(code.at(-1)) === (10 - (sum % 10)) % 10;
}

/** UPC-A, UPC-E, EAN-13, and EAN-8. Returns the digits to look up, or null. */
export function acceptedBarcode(raw: string): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 8 && digits[0] !== '0') return checkDigitOk(digits) ? digits : null;
  const parsed = normalizeUpc(digits);
  return parsed.ok ? digits : null;
}

function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.07);
    osc.onended = () => void ctx.close();
  } catch { /* a silent read is still a read */ }
  navigator.vibrate?.(60);
}

function cameraErrorMessage(e: unknown) {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission is blocked. On the Moto: Settings → Apps → Chrome (or Floor) → Permissions → Camera → Allow, then open Receive again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera found on this phone.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Camera is in use by another app. Close it, then tap Tap to start camera.';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser has no camera.';
  }
  return 'Camera unavailable. Type the digits under the barcode, or tap Tap to start camera.';
}

export function ReceiveBarcodeScanner({ onDetect, onClose, mode = 'barcode', onPhoto, banner }: {
  onDetect: (code: string) => void;
  onClose: () => void;
  mode?: 'barcode' | 'photo';
  onPhoto?: (file: File) => void;
  banner?: ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const detect = useRef(onDetect);
  detect.current = onDetect;
  const photoMode = useRef(mode === 'photo');
  photoMode.current = mode === 'photo';
  const [err, setErr] = useState('');
  const [typed, setTyped] = useState('');
  const [torchOn, setTorchOn] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [starting, setStarting] = useState(true);
  const track = useRef<MediaStreamTrack | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const stopCamera = useRef<((dismiss: boolean) => void) | null>(null);
  const startScanLoop = useRef<(() => void) | null>(null);

  useEffect(() => {
    document.body.classList.add('receive-scanner-open');
    return () => { document.body.classList.remove('receive-scanner-open'); };
  }, []);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let busy = false;
    let last = '';
    let hits = 0;
    let frame = 0;
    const userClose = { current: false };
    const halt = () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach(item => item.stop());
      stream = null;
      streamRef.current = null;
      const el = video.current;
      if (el) {
        el.pause();
        el.srcObject = null;
      }
    };
    const lifecycle = scannerLifecycle(document, window, video.current, () => {
      halt();
      if (userClose.current) close.current();
    });
    stopCamera.current = dismiss => {
      userClose.current = dismiss;
      lifecycle.stop();
    };

    const wireVideo = async (next: MediaStream) => {
      const el = video.current;
      if (!el) throw new Error('Camera view is missing.');
      el.srcObject = next;
      el.muted = true;
      el.defaultMuted = true;
      el.playsInline = true;
      el.setAttribute('playsinline', 'true');
      el.setAttribute('webkit-playsinline', 'true');
      el.setAttribute('autoplay', 'true');
      try {
        await el.play();
        setNeedsTap(false);
      } catch {
        // Android Chrome often needs a tap after getUserMedia; show an explicit start control.
        setNeedsTap(true);
      }
      const videoTrack = next.getVideoTracks()[0];
      track.current = videoTrack || null;
      try {
        const caps = videoTrack?.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean };
        // iPhone Safari has no torch API — Light stays hidden. Moto/Chrome expose caps.torch.
        setTorchOk(Boolean(caps?.torch));
      } catch {
        setTorchOk(false);
      }
    };

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let readBarcodes: ((data: ImageData, opts: object) => Promise<{ text?: string; isValid?: boolean }[]>) | null = null;
    const scan = async () => {
      const el = video.current;
      if (stopped || lifecycle.stopped || photoMode.current || !el) return;
      frame = window.requestAnimationFrame(() => void scan());
      if (busy || !el.videoWidth || !ctx || !readBarcodes) return;
      busy = true;
      try {
        canvas.width = el.videoWidth;
        canvas.height = el.videoHeight;
        ctx.drawImage(el, 0, 0);
        const found = await readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), {
          formats: [...FORMATS],
          tryHarder: true,
          maxNumberOfSymbols: 1,
        });
        const code = acceptedBarcode(found.find(row => row.isValid !== false)?.text || '');
        if (!code || stopped) { if (!code) { last = ''; hits = 0; } return; }
        if (code === last) hits += 1;
        else { last = code; hits = 1; }
        if (hits >= 2 && !stopped) {
          beep();
          stopCamera.current?.(false);
          detect.current(code);
        }
      } catch { /* keep scanning */ }
      finally { busy = false; }
    };
    startScanLoop.current = () => {
      if (stopped || lifecycle.stopped || photoMode.current) return;
      frame = window.requestAnimationFrame(() => void scan());
    };

    void (async () => {
      try {
        setStarting(true);
        setErr('');
        const zxing = await import('zxing-wasm/reader');
        await zxing.prepareZXingModule({ fireImmediately: true });
        readBarcodes = zxing.readBarcodes as typeof readBarcodes;
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera.');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (stopped) { stream.getTracks().forEach(item => item.stop()); return; }
        // attach() releases tracks when the page is already backgrounded. Never fail silently —
        // Android Chrome shows a gray play icon on an empty <video> with no error text.
        if (!lifecycle.attach(stream)) {
          stream = null;
          streamRef.current = null;
          setStarting(false);
          setNeedsTap(true);
          setErr('Camera paused. Tap Tap to start camera, or type the UPC below.');
          return;
        }
        streamRef.current = stream;
        if (stopped) { stream.getTracks().forEach(item => item.stop()); return; }
        await wireVideo(stream);
        setStarting(false);
        startScanLoop.current?.();
      } catch (e) {
        setStarting(false);
        setNeedsTap(true);
        setErr(cameraErrorMessage(e));
      }
    })();
    return () => {
      userClose.current = false;
      halt();
      lifecycle.stop();
    };
  }, []);

  async function startFromTap() {
    setErr('');
    const el = video.current;
    const existing = streamRef.current;
    try {
      if (existing && el) {
        el.srcObject = existing;
        el.muted = true;
        el.playsInline = true;
        await el.play();
        setNeedsTap(false);
        startScanLoop.current?.();
        return;
      }
      const next = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = next;
      if (!el) throw new Error('Camera view is missing.');
      el.srcObject = next;
      el.muted = true;
      el.defaultMuted = true;
      el.playsInline = true;
      el.setAttribute('playsinline', 'true');
      el.setAttribute('webkit-playsinline', 'true');
      await el.play();
      const videoTrack = next.getVideoTracks()[0];
      track.current = videoTrack || null;
      try {
        const caps = videoTrack?.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean };
        setTorchOk(Boolean(caps?.torch));
      } catch {
        setTorchOk(false);
      }
      setNeedsTap(false);
      startScanLoop.current?.();
    } catch (e) {
      setNeedsTap(true);
      setErr(cameraErrorMessage(e));
    }
  }

  async function toggleTorch() {
    const videoTrack = track.current;
    if (!videoTrack || !torchOk) return;
    const next = !torchOn;
    try {
      await videoTrack.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      // iPhone / browsers without a torch — hide Light instead of leaving a dead button.
      setTorchOn(false);
      setTorchOk(false);
    }
  }

  /** Always dismiss: lifecycle.stop() is a no-op when the camera already halted (iOS visibility blip). */
  function dismissScanner() {
    stopCamera.current?.(true);
    close.current();
  }

  function takePhoto() {
    const el = video.current;
    if (!el?.videoWidth) { setErr('Camera is not ready yet.'); return; }
    const shot = document.createElement('canvas');
    shot.width = el.videoWidth;
    shot.height = el.videoHeight;
    shot.getContext('2d')?.drawImage(el, 0, 0);
    shot.toBlob(blob => {
      if (!blob) { setErr('Could not take the photo.'); return; }
      onPhoto?.(new File([blob], 'item.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
  }

  function submitTyped() {
    const raw = typed.trim();
    // Empty Look up / Bluetooth Enter with no digits must not show a validation error.
    if (!raw) { setErr(''); return; }
    const code = acceptedBarcode(raw);
    if (!code) { setErr('That is not a valid UPC or EAN.'); return; }
    beep();
    stopCamera.current?.(false);
    onDetect(code);
  }

  return createPortal(
    <div className="receive-scanner" role="dialog" aria-modal="true" aria-label="Scan barcode">
      <video ref={video} playsInline muted autoPlay />
      <div className="receive-scanner-shade" />
      <div className="receive-scanner-frame" aria-hidden="true">
        {mode === 'photo' ? <span className="receive-scanner-caption">Take picture of item for identification</span> : <span className="receive-scanner-line" />}
      </div>
      <div className="receive-scanner-bar">
        <button type="button" onClick={dismissScanner}>Close</button>
        {torchOk ? (
          <button type="button" onClick={() => void toggleTorch()}>{torchOn ? 'Light off' : 'Light'}</button>
        ) : null}
        {mode === 'photo' && <button type="button" onClick={takePhoto}>OK</button>}
      </div>
      {banner}
      {starting && !err && !needsTap && <p className="receive-scanner-status" role="status">Starting camera…</p>}
      {needsTap && (
        <button type="button" className="receive-scanner-start" onClick={() => void startFromTap()}>
          Tap to start camera
        </button>
      )}
      {err && <p className="receive-scanner-error" role="alert">{err}</p>}
      {mode === 'barcode' && <form className="receive-scanner-type" onSubmit={event => { event.preventDefault(); submitTyped(); }}>
        <label>Type UPC<input inputMode="numeric" autoComplete="off" value={typed} onChange={event => { setTyped(event.target.value); if (err) setErr(''); }} /></label>
        <button type="submit">Look up</button>
      </form>}
    </div>,
    document.body,
  );
}
