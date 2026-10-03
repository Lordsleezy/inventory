type Still = { blob: Blob; score: number; at: number };
export type RecordedScan = { video: Blob; mimeType: string; stills: Blob[]; seconds: number };

function sharpness(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0, count = 0;
  for (let y = 8; y < height - 8; y += 8) for (let x = 8; x < width - 8; x += 8) {
    const p = (y * width + x) * 4;
    const center = data[p] + data[p + 1] + data[p + 2];
    const left = data[p - 4] + data[p - 3] + data[p - 2];
    const right = data[p + 4] + data[p + 5] + data[p + 6];
    const above = data[p - width * 4] + data[p - width * 4 + 1] + data[p - width * 4 + 2];
    const below = data[p + width * 4] + data[p + width * 4 + 1] + data[p + width * 4 + 2];
    sum += Math.abs(4 * center - left - right - above - below);
    count++;
  }
  return count ? sum / count : 0;
}

export async function startVideoScan(
  preview: HTMLVideoElement,
  onFinish: (scan: RecordedScan) => void,
  onError: (error: Error) => void,
  onEarlyStills?: (stills: Blob[]) => void,
): Promise<{ stop: () => void; abort: () => void }> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
    throw new Error('Video recording is unavailable in this app version. Use manual Receive.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 } },
  });
  const mimeType = ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) { stream.getTracks().forEach(t => t.stop()); throw new Error('No supported video encoder. Use manual Receive.'); }
  preview.srcObject = stream;
  preview.muted = true;
  preview.playsInline = true;
  await preview.play();
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 900_000, audioBitsPerSecond: 48_000 });
  const pieces: Blob[] = [], frames: Still[] = [];
  let aborted = false, earlyStills: Blob[] = [];
  const started = Date.now();
  const capture = () => {
    if (!preview.videoWidth || !preview.videoHeight) return;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1200 / Math.max(preview.videoWidth, preview.videoHeight));
    canvas.width = Math.round(preview.videoWidth * scale);
    canvas.height = Math.round(preview.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(preview, 0, 0, canvas.width, canvas.height);
    const score = sharpness(canvas), at = Date.now();
    canvas.toBlob(blob => {
      if (!blob) return;
      frames.push({ blob, score, at });
      if (!earlyStills.length && frames.length >= 2 && onEarlyStills) {
        earlyStills = frames.slice(0, 2).map(frame => frame.blob);
        onEarlyStills(earlyStills);
      }
    }, 'image/jpeg', .78);
  };
  recorder.ondataavailable = event => { if (event.data.size) pieces.push(event.data); };
  const interval = window.setInterval(capture, 1800);
  const timeout = window.setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 20_000);
  recorder.onerror = () => onError(new Error('Video recording failed. Use manual Receive.'));
  recorder.onstop = () => {
    window.clearInterval(interval); window.clearTimeout(timeout);
    stream.getTracks().forEach(t => t.stop()); preview.srcObject = null;
    if (aborted) return;
    const early = frames.filter(frame => earlyStills.includes(frame.blob));
    const best = [...early, ...frames.filter(frame => !early.includes(frame))
      .sort((a, b) => b.score - a.score).slice(0, 4 - early.length)].sort((a, b) => a.at - b.at);
    onFinish({ video: new Blob(pieces, { type: mimeType }), mimeType, stills: best.map(x => x.blob),
      seconds: Math.round((Date.now() - started) / 1000) });
  };
  recorder.start(1000);
  capture();
  return {
    stop: () => { if (recorder.state !== 'inactive') recorder.stop(); },
    abort: () => { aborted = true; if (recorder.state !== 'inactive') recorder.stop();
      else { stream.getTracks().forEach(t => t.stop()); preview.srcObject = null; } },
  };
}
