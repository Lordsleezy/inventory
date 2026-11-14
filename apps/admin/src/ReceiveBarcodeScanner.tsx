import { useEffect, useRef, useState } from 'react';
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

export function ReceiveBarcodeScanner({ onDetect, onClose }: { onDetect: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const detect = useRef(onDetect);
  detect.current = onDetect;
  const [err, setErr] = useState('');
  const [typed, setTyped] = useState('');
  const [torchOn, setTorchOn] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const track = useRef<MediaStreamTrack | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let busy = false;
    let last = '';
    let hits = 0;
    let frame = 0;
    const lifecycle = scannerLifecycle(document, window, video.current, () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      onClose();
    });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    void (async () => {
      try {
        const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');
        await prepareZXingModule({ fireImmediately: true });
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera.');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (!lifecycle.attach(stream)) return;
        if (stopped) { stream.getTracks().forEach(item => item.stop()); return; }
        const el = video.current;
        if (!el) return;
        el.srcObject = stream;
        el.setAttribute('playsinline', 'true');
        el.muted = true;
        await el.play();
        const videoTrack = stream.getVideoTracks()[0];
        track.current = videoTrack || null;
        const caps = videoTrack?.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean };
        if (caps?.torch) setTorchOk(true);
        const scan = async () => {
          if (stopped || lifecycle.stopped) return;
          frame = window.requestAnimationFrame(() => void scan());
          if (busy || !el.videoWidth || !ctx) return;
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
              stopped = true;
              beep();
              detect.current(code);
            }
          } catch { /* keep scanning */ }
          finally { busy = false; }
        };
        frame = window.requestAnimationFrame(() => void scan());
      } catch (e) {
        const name = e instanceof DOMException ? e.name : '';
        setErr(name === 'NotAllowedError'
          ? 'Allow the camera for Floor, then tap Camera again.'
          : 'Camera unavailable. Type the digits under the barcode.');
      }
    })();
    return () => { stopped = true; window.cancelAnimationFrame(frame); lifecycle.stop(); };
  }, []);

  async function toggleTorch() {
    const videoTrack = track.current;
    if (!videoTrack) return;
    const next = !torchOn;
    try {
      await videoTrack.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch { setTorchOk(false); }
  }

  function submitTyped() {
    const code = acceptedBarcode(typed);
    if (!code) { setErr('That is not a valid UPC or EAN.'); return; }
    beep();
    onDetect(code);
  }

  return createPortal(
    <div className="receive-scanner" role="dialog" aria-modal="true" aria-label="Scan barcode">
      <video ref={video} playsInline muted autoPlay />
      <div className="receive-scanner-shade" />
      <div className="receive-scanner-frame" aria-hidden="true"><span className="receive-scanner-line" /></div>
      <div className="receive-scanner-bar">
        <button type="button" onClick={onClose}>Close</button>
        {torchOk && <button type="button" onClick={() => void toggleTorch()}>{torchOn ? 'Light off' : 'Light'}</button>}
      </div>
      {err && <p className="receive-scanner-error" role="alert">{err}</p>}
      <form className="receive-scanner-type" onSubmit={event => { event.preventDefault(); submitTyped(); }}>
        <label>Type UPC<input inputMode="numeric" autoComplete="off" value={typed} onChange={event => setTyped(event.target.value)} /></label>
        <button type="submit">Look up</button>
      </form>
    </div>,
    document.body,
  );
}
