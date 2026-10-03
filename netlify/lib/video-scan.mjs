import { createHash } from 'node:crypto';
import { requireEnv } from './server.mjs';

const model = () => process.env.GEMINI_VIDEO_MODEL || 'gemini-3.8-flash';
const api = 'https://generativelanguage.googleapis.com/v1beta/models/';
const identitySchema = {type:'object',properties:{title:{type:'string'},brand:{type:'string'},model:{type:'string'},color:{type:'string'},confidence:{type:'number'},options:{type:'array',items:{type:'object',properties:{label:{type:'string'},title:{type:'string'},brand:{type:'string'},model:{type:'string'},color:{type:'string'}},required:['label','title','brand','model','color']}}},required:['title','brand','model','color','confidence','options']};
const detailSchema = {type:'object',properties:{category:{type:'string'},condition:{type:'string'},condition_notes:{type:'string'},description:{type:'string'},key_features:{type:'array',items:{type:'string'}},upc:{type:'string'},mfr_serial:{type:'string'},ebay_title:{type:'string'},ebay_category:{type:'string'},ebay_item_specifics:{type:'object',additionalProperties:{type:'string'}}},required:['category','condition','condition_notes','description','key_features','upc','mfr_serial','ebay_title','ebay_category','ebay_item_specifics']};

async function gemini(parts,{schema,search=false,maxOutputTokens=500}={}) {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),90_000);
  try {
    const response=await fetch(`${api}${encodeURIComponent(model())}:generateContent`,{method:'POST',signal:controller.signal,
      headers:{'Content-Type':'application/json','x-goog-api-key':requireEnv('GEMINI_API_KEY')},
      body:JSON.stringify({contents:[{role:'user',parts}],...(search?{tools:[{googleSearch:{}}]}:{}),
        generationConfig:{...(schema?{responseMimeType:'application/json',responseJsonSchema:schema}:{}),
          maxOutputTokens,thinkingConfig:{thinkingLevel:'LOW'}}})});
    const body=await response.json();
    if(!response.ok)throw new Error(`Gemini ${response.status}: ${body.error?.message||'request failed'}`);
    const text=body.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';
    if(!text)throw new Error('Gemini returned no text');
    const usage=body.usageMetadata||{};
    return {value:schema?JSON.parse(text):text,input:usage.promptTokenCount||0,
      output:(usage.candidatesTokenCount||0)+(usage.thoughtsTokenCount||0),
      queries:(body.candidates?.[0]?.groundingMetadata?.webSearchQueries||[]).filter(Boolean).length};
  } finally {clearTimeout(timeout)}
}

export function productKey(item) {
  const brand=String(item.brand||'').trim().toLowerCase();
  const identity=String(item.model||item.title||'').trim().toLowerCase();
  if(!brand||identity.length<4)return null;
  return createHash('sha256').update(`${brand}|${identity}|${String(item.color||'').toLowerCase()}`).digest('hex');
}
export function tokenCost(input,output) {
  return Number(((input*Number(process.env.GEMINI_INPUT_USD_PER_M||0.75)+output*Number(process.env.GEMINI_OUTPUT_USD_PER_M||3.75))/1e6).toFixed(5));
}
export async function identifyFrames(stills) {
  const parts=[{text:'Identify the exact product from these store photos. Read labels, brand, model, pack size and color. Return a short shopper-facing title. Only offer 2-3 choices if two distinct products are genuinely plausible. No description or specifications.'},
    ...stills.map(bytes=>({inlineData:{mimeType:'image/jpeg',data:bytes.toString('base64')}}))];
  const found=await gemini(parts,{schema:identitySchema,maxOutputTokens:700});
  return {...found,result:{...found.value,options:found.value.options||[]}};
}
function parseJson(text) {
  const start=text.indexOf('{'),end=text.lastIndexOf('}');
  if(start<0||end<start)throw new Error('Search did not return price data');
  return JSON.parse(text.slice(start,end+1));
}
export function cleanPrices(prices) {
  return (Array.isArray(prices)?prices:[]).filter(p=>Number.isInteger(p.price_cents)&&p.price_cents>0&&p.price_cents<10_000_000&&/^https:\/\//i.test(p.url||'')&&(()=>{
    try {const u=new URL(p.url);return !/^\/(support|help|search)(\/|$)/i.test(u.pathname)&&!/\.\.\./.test(u.href)}catch{return false}
  })()).map(p=>({store:String(p.store||'Retailer').slice(0,80),price_cents:p.price_cents,
    url:String(p.url).slice(0,1500),pack_size:Math.max(1,Math.min(1000,Number(p.pack_size)||1)),
    approximate:Boolean(p.approximate),product_name:String(p.product_name||'').slice(0,160)}))
    .sort((a,b)=>Number(a.approximate)-Number(b.approximate)||b.price_cents/a.pack_size-a.price_cents/b.pack_size).slice(0,10);
}
async function searchOnce(identity,closer=false) {
  const title=String(identity.title||'');
  const query=[!title.toLowerCase().includes(String(identity.brand||'').toLowerCase())?identity.brand:'',
    title||identity.model,
    identity.model&&!title.toLowerCase().includes(String(identity.model).toLowerCase())?identity.model:'',
    identity.color&&!title.toLowerCase().includes(String(identity.color).toLowerCase())?identity.color:'']
    .filter(Boolean).join(' ').replace(/\s+/g,' ').slice(0,180);
  const prompt=`Use ONE Google Search query for current US retail prices of "${query}". Return compact JSON ONLY: {"prices":[{"store":"...","price_cents":2199,"url":"https://direct-product-page","pack_size":12,"approximate":false,"product_name":"..."}]}. Include single items and multipacks. If the same item is only sold in a pack, give the pack price and count. ${closer?'Find a clearly labeled close variant if exact size or pack is unavailable.':'An identical product in a different pack or size is allowed, marked approximate=true. Do not reject a valid pack because the scanned item is one unit.'} Use product-page URLs, never invent a price or URL. At most one search query.`;
  const result=await gemini([{text:prompt}],{search:true,maxOutputTokens:1200});
  let prices=[];
  try {prices=cleanPrices(parseJson(result.value).prices)} catch {/* A grounded response may be prose; the retry can recover. */}
  return {...result,prices};
}
export async function lookupRetail(sb,job,identity) {
  const key=productKey(identity);
  if(key){const cached=await sb.from('video_scan_product_cache').select('lookup,created_at').eq('store_id',job.store_id).eq('product_key',key).maybeSingle();
    if(cached.error)throw cached.error;
    if(cached.data&&Date.now()-Date.parse(cached.data.created_at)<30*86400_000){
      const prices=cleanPrices(cached.data.lookup.retail_prices);
      return {prices,input:0,output:0,queries:0,reused:true,cachedDetails:cached.data.lookup};
    }}
  const first=await searchOnce(identity);
  let prices=first.prices,input=first.input,output=first.output,queries=first.queries;
  if(!prices.length){const second=await searchOnce(identity,true);prices=second.prices;input+=second.input;output+=second.output;queries+=second.queries}
  if(key&&prices.length){const saved=await sb.from('video_scan_product_cache').upsert({store_id:job.store_id,product_key:key,
    lookup:{retail_prices:prices},created_at:new Date().toISOString()});if(saved.error)throw saved.error}
  return {prices,input,output,queries,reused:false};
}
export function retailFields(prices) {
  const best=cleanPrices(prices)[0];
  return {retail_prices:cleanPrices(prices),msrp_cents:best?Math.round(best.price_cents/best.pack_size):null,
    retail_source_name:best?.store||'',retail_source_url:best?.url||''};
}
export async function enrichVideo(bytes,mimeType,identity) {
  const found=await gemini([{text:`Watch and listen to this intake video. Product already identified: ${JSON.stringify(identity)}. Read barcode/model/serial labels and spoken defects. Fill the backend listing fields. Condition must be one of New, Open box, Excellent, Good, Fair, For parts. Describe only supported features. eBay title maximum 80 characters. Never choose a selling price.`},
    {inlineData:{mimeType,data:bytes.toString('base64')}}],{schema:detailSchema,maxOutputTokens:2500});
  return {...found,result:{...found.value,ebay_title:String(found.value.ebay_title||'').slice(0,80)}};
}
