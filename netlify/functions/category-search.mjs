import { staffFromEvent, json, corsHeaders, serviceClient } from '../lib/server.mjs';
import { suggestCategories, categoryInfo } from '../lib/ebay-catalog.mjs';
import { wrapHandler, asNetlifyFunction } from '../lib/floor-log.mjs';

async function handle(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'method' });
  const { staff } = await staffFromEvent(event);
  const sb = serviceClient();
  const channel = String(event.queryStringParameters?.channel || 'ebay').toLowerCase();
  const q = String(event.queryStringParameters?.q || '').trim().slice(0, 100);
  if (!['ebay','amazon','tiktok','depop'].includes(channel) || q.length < 2)
    return json(400, { error: 'channel_and_query_required' });
  if (channel === 'depop') {
    const { data: setting } = await sb.from('store_settings').select('value')
      .eq('store_id',staff.store_id).eq('key','marketplace_channels').maybeSingle();
    if (!(setting?.value || []).some((x) => x.key === 'depop')) return json(403, { error: 'depop_disabled' });
  }
  const { data, error } = await sb.from('channel_taxonomy')
    .select('category_id,path,version,required_fields')
    .eq('channel',channel).eq('leaf',true).eq('active',true)
    .ilike('path',`%${q.replace(/[%,_]/g,'')}%`).limit(30);
  if (error) throw error;
  let rows = data || [];
  if (channel === 'ebay' && rows.length < 3) {
    const suggested = await suggestCategories(q);
    const verified = await Promise.all(suggested.map(async (x) => ({ ...x,
      info: await categoryInfo(x.categoryId) })));
    const fresh = verified.filter((x) => x.info.leaf).map((x) => ({
      channel,category_id:x.categoryId,path:x.path || x.categoryName,
      leaf:true,active:true,version:'live-suggestion',fetched_at:new Date().toISOString(),
    }));
    if (fresh.length) {
      const saved = await sb.from('channel_taxonomy').upsert(fresh,{onConflict:'channel,category_id'});
      if (saved.error) throw saved.error;
      rows = [...fresh,...rows.filter((r) => !fresh.some((x) => x.category_id === r.category_id))];
    }
  }
  return json(200, { ok:true, categories:rows.slice(0,30) });
}

export const invoke = wrapHandler('category-search',handle);
export default asNetlifyFunction(invoke);
