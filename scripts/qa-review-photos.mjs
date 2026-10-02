import sharp from 'sharp';
import { serviceClient } from '../netlify/lib/server.mjs';

const sb = serviceClient();
const { data: suggestions, error } = await sb.from('photo_enrichment_suggestions')
  .select('sku,own_photo_path,asset_id,confidence,source:photo_enrichment_assets(source_title,candidate_paths)')
  .eq('status', 'review').order('sku').limit(200);
if (error) throw error;
const rows = [];
const bestBySku = new Map();
for (const suggestion of suggestions || []) {
  const previous = bestBySku.get(suggestion.sku);
  if (!previous || Number(suggestion.confidence) > Number(previous.confidence)) bestBySku.set(suggestion.sku, suggestion);
}
const download = async (bucket, path) => {
  if (!path) return null;
  const result = await sb.storage.from(bucket).download(path);
  return result.error ? null : Buffer.from(await result.data.arrayBuffer());
};
for (const suggestion of bestBySku.values()) {
  const source = Array.isArray(suggestion.source) ? suggestion.source[0] : suggestion.source;
  const own = await download('unit-photos', suggestion.own_photo_path);
  const candidate = await download('photo-match-candidates', source?.candidate_paths?.[0]);
  if (!own || !candidate) continue;
  rows.push({ sku: suggestion.sku, title: source?.source_title || '', own, candidate });
}
const perSheet = 25;
for (let start = 0; start < rows.length; start += perSheet) {
  const page = rows.slice(start, start + perSheet);
  const tiles = [];
  for (const [index, row] of page.entries()) {
    const y = index * 260;
    for (const [x, bytes] of [[0, row.own], [360, row.candidate]]) {
      const img = await sharp(bytes).rotate().resize(340, 205, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
      tiles.push({ input: img, left: x + 10, top: y + 35 });
    }
    const safe = `${row.sku} | ${row.title.slice(0, 78)}`.replace(/[&<>]/g, ' ');
    const label = Buffer.from(`<svg width="720" height="30"><rect width="720" height="30" fill="#eeeeee"/><text x="10" y="21" font-size="16" font-family="Arial">${safe}</text></svg>`);
    tiles.push({ input: label, left: 0, top: y });
  }
  const file = `${process.env.TEMP || '/tmp'}/floor-review-${Math.floor(start / perSheet) + 1}.png`;
  await sharp({ create: { width: 720, height: page.length * 260, channels: 3, background: '#ffffff' } })
    .composite(tiles).png().toFile(file);
  console.log(file);
}
console.log(`Reviewed candidates: ${rows.length}`);
