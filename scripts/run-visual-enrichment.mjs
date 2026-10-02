import { serviceClient } from '../netlify/lib/server.mjs';
import { processPhotoMatch } from '../netlify/lib/photo-match-worker.mjs';

const sb = serviceClient();
const max = Number(process.argv.find((arg) => arg.startsWith('--max='))?.slice(6) || 500);
const workers = Math.max(1, Math.min(4, Number(process.argv.find((arg) => arg.startsWith('--workers='))?.slice(10) || 3)));
const { data: rows, error } = await sb.from('photo_enrichment_queue')
  .select('store_id,sku,identity_key,attempts')
  .in('status', ['pending', 'no_match'])
  .lte('next_attempt_at', new Date().toISOString())
  .order('sku')
  .limit(max);
if (error) throw error;

const groups = new Map();
for (const row of rows) {
  const group = groups.get(row.identity_key) || [];
  group.push(row);
  groups.set(row.identity_key, group);
}
const work = [...groups.values()];
let next = 0;
const counts = {};
await Promise.all(Array.from({ length: Math.min(workers, work.length) }, async () => {
  while (next < work.length) {
    const group = work[next++];
    for (const row of group) {
      const status = await processPhotoMatch(row, sb);
      counts[status] = (counts[status] || 0) + 1;
      console.log(`${row.sku}: ${status}`);
    }
  }
}));
console.log(JSON.stringify({ processed: rows.length, counts }));
