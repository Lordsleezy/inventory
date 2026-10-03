type Still = { blob: Blob; score: number; at: number; signature: Uint8Array };
export type RecordedScan = { video: Blob; mimeType: string; stills: Blob[]; seconds: number };

function frameQuality(canvas: HTMLCanvasElement): { score: number; signature: Uint8Array } {
  const sample=document.createElement('canvas');sample.width=256;sample.height=256;
  sample.getContext('2d')?.drawImage(canvas,0,0,256,256);
  canvas=sample;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return {score:0,signature:new Uint8Array(256)};
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray=(p:number)=>Math.round(.299*data[p]+.587*data[p+1]+.114*data[p+2]);
  let sum = 0, count = 0;
  for (let y = 8; y < height - 8; y += 3) for (let x = 8; x < width - 8; x += 3) {
    const p = (y * width + x) * 4;
    const center = gray(p), left = gray(p-4), right = gray(p+4);
    const above = gray(p-width*4), below = gray(p+width*4);
    sum += Math.abs(4 * center - left - right - above - below);
    count++;
  }
  const values=[];
  for(let y=0;y<16;y++)for(let x=0;x<16;x++)values.push(gray(((y*16+8)*width+x*16+8)*4));
  const mean=values.reduce((a,b)=>a+b,0)/values.length;
  return {score:count?sum/count:0,signature:Uint8Array.from(values.map(v=>v>=mean?1:0))};
}
function different(a:Still,b:Still):boolean {
  let bits=0;for(let i=0;i<a.signature.length;i++)bits+=a.signature[i]!==b.signature[i]?1:0;
  return bits>35;
}
const MIN_SHARPNESS=12;

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
    const {score,signature}=frameQuality(canvas), at = Date.now();
    canvas.toBlob(blob => {
      if (!blob) return;
      frames.push({ blob, score, at,signature });
      const ready=frames.filter(frame=>frame.score>=MIN_SHARPNESS).sort((a,b)=>b.score-a.score);
      const distinct:Still[]=[];
      for(const frame of ready)if(distinct.every(other=>different(frame,other)))distinct.push(frame);
      if (!earlyStills.length && distinct.length >= 2 && onEarlyStills) {
        earlyStills = distinct.slice(0, 2).map(frame => frame.blob);
        onEarlyStills(earlyStills);
      }
    }, 'image/jpeg', .78);
  };
  recorder.ondataavailable = event => { if (event.data.size) pieces.push(event.data); };
  const interval = window.setInterval(capture, 300);
  const timeout = window.setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 20_000);
  recorder.onerror = () => onError(new Error('Video recording failed. Use manual Receive.'));
  recorder.onstop = async () => {
    window.clearInterval(interval); window.clearTimeout(timeout);
    stream.getTracks().forEach(t => t.stop()); preview.srcObject = null;
    if (aborted) return;
    await new Promise(resolve=>window.setTimeout(resolve,350));
    const seconds=Math.round((Date.now()-started)/1000);
    if(seconds<10){onError(new Error('Record at least 10 seconds. Please rescan.'));return}
    const early=frames.filter(frame=>earlyStills.includes(frame.blob));
    const best:Still[]=[...early];
    for(const frame of [...frames].filter(frame=>frame.score>=MIN_SHARPNESS).sort((a,b)=>b.score-a.score)){
      if(best.length>=4)break;
      if(best.every(other=>different(frame,other)))best.push(frame);
    }
    if(best.length<2){onError(new Error('Not enough sharp, different views. Hold still briefly on the front and another side, then rescan.'));return}
    onFinish({ video: new Blob(pieces, { type: mimeType }), mimeType, stills: best.map(x => x.blob),seconds });
  };
  recorder.start(1000);
  capture();
  return {
    stop: () => { if (recorder.state !== 'inactive') recorder.stop(); },
    abort: () => { aborted = true; if (recorder.state !== 'inactive') recorder.stop();
      else { stream.getTracks().forEach(t => t.stop()); preview.srcObject = null; } },
  };
}
