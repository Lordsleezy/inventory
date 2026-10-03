// Production smoke test. All credentials are read from environment; temporary data is cleaned up.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = 'https://zoukmsmbztcuyoslvikp.supabase.co';
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
const client = createClient(url, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const scanId = randomUUID();
const email = `floor-scan-test-${scanId}@example.invalid`;
const password = randomUUID() + randomUUID();
let userId, storeId, sku;
let videoPath, stillPath;
function check(result, label) { if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data; }
async function post(name) {
  const session = check(await client.auth.getSession(), 'get session').session;
  const response = await fetch(`https://inventoryobi.netlify.app/.netlify/functions/${name}`, {
    method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: scanId }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${name}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}
try {
  storeId = check(await admin.from('portal_admins').select('store_id').limit(1).single(), 'find store').store_id;
  userId = check(await admin.auth.admin.createUser({ email, password, email_confirm: true }), 'create test login').user.id;
  check(await admin.from('portal_admins').insert({ user_id: userId, store_id: storeId }), 'give temporary access');
  check(await client.auth.signInWithPassword({ email, password }), 'test login');
  const prefix = `${storeId}/${userId}/${scanId}`;
  videoPath = `${prefix}/video.mp4`; stillPath = `${prefix}/still-0.jpg`;
  const video = await readFile(process.argv[2]);
  const still = await readFile(process.argv[3]);
  const startedAt = performance.now();
  check(await client.storage.from('video-scan-staging').upload(stillPath, still, { contentType: 'image/jpeg' }), 'upload still');
  check(await client.rpc('video_scan_create', { p_id: scanId, p_video_path: videoPath, p_still_paths: [stillPath] }), 'create job');
  await post('video-scan-start');
  const videoUpload = client.storage.from('video-scan-staging').upload(videoPath, video, { contentType: 'video/mp4' });
  let job;
  for (let n = 0; n < 180; n++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    job = check(await client.from('video_scan_jobs').select('*').eq('id', scanId).single(), 'poll job');
    if (job.status === 'ready' || job.status === 'failed') break;
  }
  if (job.status !== 'ready') throw new Error(`Scan ended as ${job.status}: ${job.error || 'timed out'}`);
  const popupMs = Math.round(performance.now() - startedAt);
  check(await videoUpload, 'upload video');
  for (let n = 0; n < 180 && !job.result?.retail_ready; n++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    job = check(await client.from('video_scan_jobs').select('*').eq('id', scanId).single(), 'poll retail');
  }
  const retailMs = Math.round(performance.now() - startedAt);
  if (!job.result?.brand || !job.result?.title) throw new Error('Draft lacks product identity');
  if ('ask_cents' in job.result) throw new Error('AI set a selling price');
  const saved = check(await client.rpc('video_scan_receive', { p_id: scanId, p_draft: job.result, p_ask_cents: 100 }), 'receive unit');
  sku = saved.sku;
  check(await admin.from('units').update({ state: 'voided', show_on_website: false }).eq('store_id', storeId).eq('sku', sku), 'hide test unit');
  const photos = await post('video-scan-photos');
  if (photos.attached !== 1) throw new Error('Video still was not attached');
  await post('video-scan-enrich-start');
  for (let n = 0; n < 240; n++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    job = check(await client.from('video_scan_jobs').select('*').eq('id', scanId).single(), 'poll details');
    if (job.result?.details_ready || job.error) break;
  }
  const unit = check(await admin.from('units').select('brand,model,title,ask_cents,msrp_cents,ebay_title,ebay_category,ebay_item_specifics,ai_description,defect_notes').eq('store_id', storeId).eq('sku', sku).single(), 'verify unit');
  const photo = check(await admin.from('photos').select('source,path').eq('store_id', storeId).eq('sku', sku).single(), 'verify photo');
  const videoInfo = await admin.storage.from('video-scan-staging').info(videoPath);
  if (!videoInfo.error) throw new Error('Raw video remains in storage');
  console.log(JSON.stringify({ scan_status: job.status, sku, brand: unit.brand, model: unit.model,
    ask_cents: unit.ask_cents, msrp_cents: unit.msrp_cents, retailer: job.result.retail_source_name,
    retailer_url: job.result.retail_source_url, photo_source: photo.source,
    raw_video_deleted: true, popup_ms: popupMs, retail_ms: retailMs,
    details_ready: Boolean(job.result.details_ready), ebay_title: unit.ebay_title,
    ebay_category: unit.ebay_category, specifics_count: Object.keys(unit.ebay_item_specifics || {}).length,
    description_length: unit.ai_description?.length || 0, input_tokens: job.input_tokens,
    output_tokens: job.output_tokens, search_queries: job.search_queries,
    token_cost_usd: job.estimated_cost_usd }, null, 2));
} finally {
  if (sku && storeId) {
    const prefix = `${storeId}/${sku}/video-${scanId}-0`;
    await admin.storage.from('unit-photos').remove([`${prefix}.jpg`, `${storeId}/${sku}/web/400/video-${scanId}-0.webp`, `${storeId}/${sku}/web/1200/video-${scanId}-0.webp`]);
    await admin.from('photos').delete().eq('store_id', storeId).eq('sku', sku);
    await admin.from('events').delete().eq('store_id', storeId).eq('sku', sku);
    await admin.from('listings').delete().eq('store_id', storeId).eq('sku', sku);
    await admin.from('units').delete().eq('store_id', storeId).eq('sku', sku);
    await admin.from('sku_ledger').update({ fate: 'hard-deleted' }).eq('store_id', storeId).eq('sku', sku);
  }
  if (videoPath) await admin.storage.from('video-scan-staging').remove([videoPath, stillPath]);
  await admin.from('video_scan_jobs').delete().eq('id', scanId);
  if (userId) await admin.auth.admin.deleteUser(userId);
  console.log(`Cleanup attempted for temporary unit ${sku || '(none)'}.`);
}
