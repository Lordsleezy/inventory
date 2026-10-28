import { scannerLifecycle } from './scannerLifecycle';
export async function scanBarcode(): Promise<string | null> {
  const Detector = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (src: ImageBitmapSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (!Detector) return null;
  let stream: MediaStream | null = null;
  const video = document.createElement('video');
  const lifecycle = scannerLifecycle(document, window, video);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    if (!lifecycle.attach(stream)) return null;
    const detector = new Detector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'] });
    video.setAttribute('playsinline', 'true');
    await video.play();
    const deadline = Date.now() + 12_000;
    while (!lifecycle.stopped && Date.now() < deadline) {
      const bitmap = await createImageBitmap(video);
      try {
        const codes = await detector.detect(bitmap);
        if (!lifecycle.stopped && codes[0]?.rawValue) return codes[0].rawValue;
      } finally { bitmap.close(); }
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  } catch {
    return null;
  } finally {
    lifecycle.stop();
  }
}

