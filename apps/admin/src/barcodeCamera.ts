export async function scanBarcode(): Promise<string | null> {
  const Detector = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (src: ImageBitmapSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (!Detector) return null;
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const track = stream.getVideoTracks()[0];
    const detector = new Detector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'] });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    await video.play();
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const bitmap = await createImageBitmap(video);
      const codes = await detector.detect(bitmap);
      bitmap.close();
      if (codes[0]?.rawValue) return codes[0].rawValue;
      await new Promise(r => setTimeout(r, 200));
    }
    void track;
    return null;
  } catch {
    return null;
  } finally {
    stream?.getTracks().forEach(t => t.stop());
  }
}

