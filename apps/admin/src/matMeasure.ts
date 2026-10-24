/** Best-effort footprint measurement from Floor's four 50 mm black-square mat. */
export async function measureMatPhoto(file: File): Promise<{ product_width_in: number; product_depth_in: number } | null> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { return null; }
  try {
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, w, h);
    const data = context.getImageData(0, 0, w, h).data;
    const seen = new Uint8Array(w * h);
    type BlobBox = { x0: number; x1: number; y0: number; y1: number; area: number; cx: number; cy: number };
    const components: BlobBox[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (seen[start]) continue;
      seen[start] = 1;
      const i = start * 4;
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 70) continue;
      const queue = [start];
      let x0 = x, x1 = x, y0 = y, y1 = y, area = 0;
      for (let head = 0; head < queue.length; head++) {
        const pos = queue[head], px = pos % w, py = Math.floor(pos / w);
        area++; x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
        for (const next of [pos - 1, pos + 1, pos - w, pos + w]) {
          if (next < 0 || next >= seen.length || Math.abs((next % w) - px) + Math.abs(Math.floor(next / w) - py) !== 1 || seen[next]) continue;
          seen[next] = 1;
          const k = next * 4;
          if (Math.max(data[k], data[k + 1], data[k + 2]) <= 70) queue.push(next);
        }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (area > w * h * 0.004 && bw / bh > 0.5 && bw / bh < 1.8 && area / (bw * bh) > 0.6)
        components.push({ x0, x1, y0, y1, area, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    }
    const marker = (left: boolean, top: boolean) => components
      .filter(c => (left ? c.cx < w * 0.4 : c.cx > w * 0.6) && (top ? c.cy < h * 0.4 : c.cy > h * 0.6))
      .sort((a, b) => b.area - a.area)[0];
    const tl = marker(true, true), tr = marker(false, true), bl = marker(true, false), br = marker(false, false);
    if (!tl || !tr || !bl || !br) return null;
    const pxPerIn = [tl, tr, bl, br].reduce((sum, c) => sum + ((c.x1 - c.x0 + c.y1 - c.y0 + 2) / 2), 0) / 4 / (50 / 25.4);
    if (pxPerIn < 8) return null;
    const x0 = Math.max(tl.x1, bl.x1) + 2, x1 = Math.min(tr.x0, br.x0) - 2;
    const y0 = Math.max(tl.y1, tr.y1) + 2, y1 = Math.min(bl.y0, br.y0) - 2;
    if (x1 - x0 < 30 || y1 - y0 < 30) return null;
    // Ignore the printed dashed center guide by requiring a dense foreground block.
    let minX = x1, maxX = x0, minY = y1, maxY = y0, foreground = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      if (Math.min(data[i], data[i + 1], data[i + 2]) > 170) continue;
      foreground++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (foreground < (x1 - x0) * (y1 - y0) * 0.12 || maxX - minX < 16 || maxY - minY < 16) return null;
    return { product_width_in: Math.ceil((maxX - minX + 1) / pxPerIn * 10) / 10,
      product_depth_in: Math.ceil((maxY - minY + 1) / pxPerIn * 10) / 10 };
  } finally { bitmap.close(); }
}
