import { serviceClient } from './server.mjs';
import { autoFillUnit, supabaseAutoFillDeps } from './auto-fill.mjs';
import { supabaseSpecificsDeps } from './ebay-specifics.mjs';
import { catalogProductByGtin, suggestCategories } from './ebay-catalog.mjs';
import { liveSpecificsForUnit } from './ebay-live-specifics.mjs';
import { refreshChannelCategoryFields } from './category-taxonomy.mjs';
import { resolveUnitCategories } from './category-resolve.mjs';

const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
import { executeReceiveJob } from './receive-job-runner.mjs';

async function archiveBeforeStep(sb, job, step) {
  const [unit, photos, categories, selections] = await Promise.all([
    sb.from('units').select('*').eq('store_id', job.store_id).eq('sku', job.sku).single(),
    sb.from('photos').select('*').eq('store_id', job.store_id).eq('sku', job.sku),
    sb.from('unit_channel_categories').select('*').eq('store_id', job.store_id).eq('sku', job.sku),
    sb.from('unit_channel_selections').select('*').eq('store_id', job.store_id).eq('sku', job.sku),
  ]);
  must(await sb.from('receive_job_audit').insert({ job_id: job.id, step,
    before_rows: { unit: must(unit), photos: must(photos), categories: must(categories), selections: must(selections) } }));
}

async function processPhotos(sb, job) {
  const sharp = (await import('sharp')).default;
  const photos = must(await sb.from('photos').select('id,path,original_path').eq('store_id', job.store_id).eq('sku', job.sku));
  for (const photo of photos) {
    const original = photo.original_path || photo.path;
    const bucket = sb.storage.from('unit-photos');
    const blob = must(await bucket.download(original));
    const bytes = Buffer.from(await blob.arrayBuffer());
    const name = original.split('/').at(-1);
    const final = `${job.store_id}/${job.sku}/${name}`;
    if (original !== final) {
      must(await bucket.upload(final, bytes, { contentType: blob.type || 'image/jpeg', upsert: true }));
    }
    // Originals stay intact. Generating display copies does not delay Receive.
    for (const width of [400, 1200]) {
      const web = `${job.store_id}/${job.sku}/web/${width}/${name.replace(/\.[^.]+$/, '')}.webp`;
      const image = await sharp(bytes).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      must(await bucket.upload(web, image, { contentType: 'image/webp', upsert: true }));
    }
    must(await sb.from('photos').update({ path: final, original_path: final }).eq('id', photo.id).eq('store_id', job.store_id));
    // Staged originals are retained for recovery; never delete a receiver's only photo on a failed save.
  }
}

export async function drainReceiveJobs({ sb = serviceClient(), storeId = null, limit = 2 } = {}) {
  const jobs = must(await sb.rpc('receive_claim_jobs', { p_store: storeId, p_limit: limit })) || [];
  const results = [];
  for (const job of jobs) {
    const commit = must(await sb.from('receive_commits').select('extras').eq('id', job.id).single());
    const extras = commit.extras || {};
    const save = async patch => {
      const rows = must(await sb.from('receive_jobs').update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', job.id).eq('lease', job.lease).select('id'));
      if (!rows?.length) throw new Error('receive_job_lease_lost');
    };
    results.push(await executeReceiveJob(job, { save, step: async name => {
      await archiveBeforeStep(sb, job, name);
      if (name === 'photos') return processPhotos(sb, job);
      if (name === 'autofill') {
        const aspectFields = async id => {
          let row = must(await sb.from('channel_taxonomy').select('aspect_fields,required_fields').eq('channel', 'ebay').eq('category_id', id).maybeSingle());
          if (!row?.aspect_fields?.length) {
            await refreshChannelCategoryFields('ebay', job.store_id, id);
            row = must(await sb.from('channel_taxonomy').select('aspect_fields,required_fields').eq('channel', 'ebay').eq('category_id', id).maybeSingle());
          }
          return row?.aspect_fields?.length ? row.aspect_fields : row?.required_fields || [];
        };
        const specificsDeps = supabaseSpecificsDeps(sb, { catalog: catalogProductByGtin, aspectFields,
          loadLive: (st, sku) => liveSpecificsForUnit(st, sku) });
        const deps = supabaseAutoFillDeps(sb, { suggestCategories, specificsDeps, ebayAspectFields: aspectFields });
        const result = await autoFillUnit(deps, job.store_id, job.sku);
        if (result.category === 'suggestion_error') throw new Error('Category lookup unavailable; will retry');
      }
      if (name === 'categories') await resolveUnitCategories(job.store_id, job.sku, { network: true });
      if (name === 'channels' && !extras.dns && !extras.do_not_list) {
        // Existing selection logic handles eligibility and the paced listing queue.
        for (const channel of extras.channels || []) {
          must(await sb.rpc('floor_receive_apply_channel', { p_store: job.store_id, p_sku: job.sku, p_channel: channel }));
        }
      }
      if (name === 'visibility') {
        const unit = must(await sb.from('units').select('listing_specs').eq('store_id', job.store_id).eq('sku', job.sku).single());
        must(await sb.from('units').update({ show_on_website: !extras.do_not_list && !unit.listing_specs?.do_not_list && extras.enrichment?.show !== false })
          .eq('store_id', job.store_id).eq('sku', job.sku));
      }
    } }));
  }
  return results;
}
