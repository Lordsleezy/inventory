/**
 * Rasterize the eBay store logo and billboards from the website mark.
 * Colors match openbox-store-web (ink, gold, cream). No other brand logos.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const dir = path.dirname(fileURLToPath(import.meta.url));

const logo = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
  <rect width="300" height="300" rx="64" fill="#1d1d1f"/>
  <rect x="75" y="75" width="150" height="150" rx="28" fill="none" stroke="#f5f5f7" stroke-width="14"/>
</svg>`;

function banner(width, height) {
  const mark = Math.round(height * 0.52);
  const markX = Math.round(width * 0.055);
  const markY = Math.round((height - mark) / 2);
  const textX = markX + mark + Math.round(width * 0.035);
  const eyebrow = Math.round(height * 0.4);
  const title = Math.round(height * 0.58);
  const sub = Math.round(height * 0.74);
  const titleSize = Math.round(height * 0.16);
  const subSize = Math.round(height * 0.075);
  const eyeSize = Math.round(height * 0.062);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#0c0b0a"/>
  <rect width="${width}" height="4" fill="#d4a574"/>
  <g transform="translate(${markX} ${markY})">
    <rect width="${mark}" height="${mark}" rx="${Math.round(mark * 0.21)}" fill="#1d1d1f"/>
    <rect x="${Math.round(mark * 0.25)}" y="${Math.round(mark * 0.25)}" width="${Math.round(mark * 0.5)}" height="${Math.round(mark * 0.5)}" rx="${Math.round(mark * 0.09)}" fill="none" stroke="#f5f5f7" stroke-width="${Math.max(4, Math.round(mark * 0.045))}"/>
  </g>
  <text x="${textX}" y="${eyebrow}" fill="#d4a574" font-family="Segoe UI, Arial, sans-serif" font-size="${eyeSize}" letter-spacing="3">CLEARANCE OUTLET</text>
  <text x="${textX}" y="${title}" fill="#f4efe8" font-family="Georgia, 'Times New Roman', serif" font-size="${titleSize}">Open Box Industries</text>
  <text x="${textX}" y="${sub}" fill="#c9bba8" font-family="Segoe UI, Arial, sans-serif" font-size="${subSize}">Brand-new and open-box deals · Penryn, CA</text>
</svg>`;
}

function square() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <rect width="640" height="640" fill="#0c0b0a"/>
  <rect x="48" y="48" width="544" height="544" rx="28" fill="none" stroke="#d4a574" stroke-width="3"/>
  <g transform="translate(220 120)">
    <rect width="200" height="200" rx="42" fill="#1d1d1f"/>
    <rect x="50" y="50" width="100" height="100" rx="18" fill="none" stroke="#f5f5f7" stroke-width="9"/>
  </g>
  <text x="320" y="400" text-anchor="middle" fill="#d4a574" font-family="Segoe UI, Arial, sans-serif" font-size="18" letter-spacing="3">CLEARANCE OUTLET</text>
  <text x="320" y="460" text-anchor="middle" fill="#f4efe8" font-family="Georgia, 'Times New Roman', serif" font-size="42">Open Box Industries</text>
  <text x="320" y="510" text-anchor="middle" fill="#c9bba8" font-family="Segoe UI, Arial, sans-serif" font-size="22">Penryn, CA</text>
</svg>`;
}

const files = [
  ["logo-300.png", logo],
  ["billboard-1280x290.png", banner(1280, 290)],
  ["billboard-1200x270.png", banner(1200, 270)],
  ["marketing-640.png", square()],
];

for (const [name, svg] of files) {
  const out = path.join(dir, name);
  await sharp(Buffer.from(svg)).png().toFile(out);
  const meta = await sharp(out).metadata();
  console.log(`${name} ${meta.width}x${meta.height}`);
}
