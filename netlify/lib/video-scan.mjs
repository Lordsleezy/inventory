import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { requireEnv } from './server.mjs';

const model = () => process.env.GEMINI_VIDEO_MODEL || 'gemini-3.8-flash';
const api = 'https://generativelanguage.googleapis.com/v1beta/models/';
const identitySchema = {type:'object',properties:{title:{type:'string'},brand:{type:'string'},model:{type:'string'},color:{type:'string'},confidence:{type:'number'},options:{type:'array',items:{type:'object',properties:{label:{type:'string'},title:{type:'string'},brand:{type:'string'},model:{type:'string'},color:{type:'string'}},required:['label','title','brand','model','color']}}},required:['title','brand','model','color','confidence','options']};
const detailSchema = {type:'object',properties:{category:{type:'string'},condition:{type:'string'},condition_notes:{type:'string'},description:{type:'string'},key_features:{type:'array',items:{type:'string'}},upc:{type:'string'},mfr_serial:{type:'string'},ebay_title:{type:'string'},ebay_category:{type:'string'},ebay_item_specifics:{type:'object',additionalProperties:{type:'string'}},
  product_height_in:{type:'number'},product_width_in:{type:'number'},product_depth_in:{type:'number'},product_weight_lb:{type:'number'},
  package_length_in:{type:'number'},package_width_in:{type:'number'},package_height_in:{type:'number'},package_weight_lb:{type:'number'},
  dims_source:{type:'string',enum:['verified','estimated']}},required:['category','condition','condition_notes','description','key_features','upc','mfr_serial','ebay_title','ebay_category','ebay_item_specifics']};
const pricesSchema={type:'object',properties:{prices:{type:'array',items:{type:'object',properties:{
  store:{type:'string'},price_cents:{type:'integer'},url:{type:'string'},pack_size:{type:'integer'},
  approximate:{type:'boolean'},product_name:{type:'string'}},
  required:['store','price_cents','url','pack_size','approximate','product_name']}}},required:['prices']};

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
      queries:(body.candidates?.[0]?.groundingMetadata?.webSearchQueries||[]).filter(Boolean).length,
      sources:(body.candidates?.[0]?.groundingMetadata?.groundingChunks||[])
        .map(chunk=>({title:chunk.web?.title||'',url:chunk.web?.uri||''})).filter(source=>source.url)};
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
  const options=[...new Map((found.value.options||[]).map(option=>[
    [option.brand,option.model,option.color].join('|').toLowerCase(),option])).values()];
  return {...found,result:{...found.value,options:options.length>=2?options.slice(0,3):[]}};
}
async function fingerprint(bytes) {
  const pixels=await sharp(bytes).resize(9,8,{fit:'fill'}).grayscale().raw().toBuffer();
  let hash=0n;
  for(let y=0;y<8;y++)for(let x=0;x<8;x++)
    hash=(hash<<1n)|(pixels[y*9+x]>pixels[y*9+x+1]?1n:0n);
  return hash.toString(16).padStart(16,'0');
}
function distance(a,b) {
  let bits=BigInt(`0x${a}`)^BigInt(`0x${b}`),count=0;
  while(bits){bits&=bits-1n;count++}
  return count;
}
export async function identifyFramesCached(sb,job,stills) {
  const fingerprints=await Promise.all(stills.map(fingerprint));
  const recent=await sb.from('video_scan_visual_cache').select('fingerprints,identity,created_at')
    .eq('store_id',job.store_id).order('created_at',{ascending:false}).limit(250);
  if(recent.error)throw recent.error;
  const match=(recent.data||[]).find(row=>row.fingerprints.length===fingerprints.length
    &&row.fingerprints.every((hash,index)=>distance(hash,fingerprints[index])<=3)
    &&Date.now()-Date.parse(row.created_at)<30*86400_000);
  if(match)return {result:{...match.identity,visual_reused:true},input:0,output:0,queries:0};
  const found=await identifyFrames(stills);
  if(Number(found.result.confidence)>=0.6&&found.result.brand&&found.result.title&&!found.result.options?.length){
    const fingerprintKey=createHash('sha256').update(fingerprints.join('|')).digest('hex');
    const stored=await sb.from('video_scan_visual_cache').upsert({store_id:job.store_id,
      fingerprint_key:fingerprintKey,fingerprints,identity:found.result,created_at:new Date().toISOString()});
    if(stored.error)throw stored.error;
  }
  return found;
}
function ounces(text) {
  const match=String(text||'').replace(/[-_]/g,' ').match(/\b(\d+(?:\.\d+)?)\s*(?:fl\s*)?oz\b/i);
  return match?Number(match[1]):null;
}
export function cleanPrices(prices,identity={}) {
  const itemSize=ounces(identity.title);
  return (Array.isArray(prices)?prices:[]).filter(p=>Number.isInteger(p.price_cents)&&p.price_cents>0&&p.price_cents<10_000_000&&/^https:\/\//i.test(p.url||'')&&(()=>{
    try {const u=new URL(p.url);return !/^\/(support|help|search)(\/|$)/i.test(u.pathname)&&!/\.\.\./.test(u.href)}catch{return false}
  })()).map(p=>{const listedSize=ounces(p.product_name)||ounces(p.url);
    const sizeMismatch=Boolean(itemSize&&listedSize&&Math.abs(itemSize-listedSize)>0.1);
    return {store:String(p.store||'Retailer').slice(0,80),price_cents:p.price_cents,
    url:String(p.url).slice(0,1500),pack_size:Math.max(1,Math.min(1000,Number(p.pack_size)||1)),
    approximate:Boolean(p.approximate)||sizeMismatch||(/variety/i.test(p.product_name||'')&&!/variety/i.test(identity.title||'')),
    size_mismatch:sizeMismatch,product_name:String(p.product_name||'').slice(0,160)}})
    .sort((a,b)=>Number(a.approximate)-Number(b.approximate)||b.price_cents/a.pack_size-a.price_cents/b.pack_size).slice(0,10);
}
async function resolveRetailUrls(prices) {
  return Promise.all(prices.map(async price=>{
    if(!/^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i.test(price.url))
      return price;
    try {
      const response=await fetch(price.url,{method:'HEAD',redirect:'follow',signal:AbortSignal.timeout(6000)});
      const final=new URL(response.url);
      if(final.protocol==='https:'&&final.hostname!=='vertexaisearch.cloud.google.com'
        &&final.pathname.length>8)return {...price,url:final.href};
    } catch {/* The grounding link remains usable if the store blocks server-side checks. */}
    return price;
  }));
}
async function searchOnce(identity,closer=false) {
  const title=String(identity.title||'');
  const query=[!title.toLowerCase().includes(String(identity.brand||'').toLowerCase())?identity.brand:'',
    title||identity.model,
    identity.model&&!title.toLowerCase().includes(String(identity.model).toLowerCase())?identity.model:'',
    identity.color&&!title.toLowerCase().includes(String(identity.color).toLowerCase())?identity.color:'']
    .filter(Boolean).join(' ').replace(/\s+/g,' ').slice(0,180);
  const prompt=`Use Google Search now for today's US retail prices of "${query}". Search with one exact product query. Report retailer product pages, current dollar prices, sizes and pack counts, with source links. ${closer?'If the exact size is not listed, find a clearly labeled close size or pack.':'Include multipacks containing the item, even when a single unit has no listing.'} Do not rely on memory or invent prices. Keep the answer short.`;
  const grounded=await gemini([{text:prompt}],{search:true,maxOutputTokens:1100});
  if(!grounded.queries)return {...grounded,prices:[]};
  const parsed=await gemini([{text:`Extract verified retail prices from these Google-grounded findings. Product: ${JSON.stringify(identity)}. Findings: ${grounded.value.slice(0,9000)}. Sources: ${JSON.stringify(grounded.sources).slice(0,4000)}. Use only linked product pages and observed prices. If the item is a single can but sold only in a variety pack, give pack_size and mark approximate=true. If a different size or variant, mark approximate=true. If no priced product page, return an empty prices array. Do not invent a URL or price.`}],
    {schema:pricesSchema,maxOutputTokens:800});
  return {prices:await resolveRetailUrls(cleanPrices(parsed.value.prices,identity)),input:grounded.input+parsed.input,
    output:grounded.output+parsed.output,queries:grounded.queries};
}
export async function lookupRetail(sb,job,identity) {
  const key=productKey(identity);
  if(key){const cached=await sb.from('video_scan_product_cache').select('lookup,created_at').eq('store_id',job.store_id).eq('product_key',key).maybeSingle();
    if(cached.error)throw cached.error;
    if(cached.data&&Date.now()-Date.parse(cached.data.created_at)<
      (cached.data.lookup.retail_prices?.length?30:1)*86400_000){
      const prices=await resolveRetailUrls(cleanPrices(cached.data.lookup.retail_prices,identity));
      return {prices,input:0,output:0,queries:0,reused:true,cachedDetails:cached.data.lookup};
    }}
  const first=await searchOnce(identity);
  let prices=first.prices,input=first.input,output=first.output,queries=first.queries;
  if(!prices.length){const second=await searchOnce(identity,true);prices=second.prices;input+=second.input;output+=second.output;queries+=second.queries}
  if(key){const saved=await sb.from('video_scan_product_cache').upsert({store_id:job.store_id,product_key:key,
    lookup:{retail_prices:prices},created_at:new Date().toISOString()});if(saved.error)throw saved.error}
  return {prices,input,output,queries,reused:false};
}
export function retailFields(prices,identity={}) {
  const cleaned=cleanPrices(prices,identity),best=cleaned[0];
  return {retail_prices:cleaned,msrp_cents:best&&!best.size_mismatch?Math.round(best.price_cents/best.pack_size):null,
    retail_source_name:best?.store||'',retail_source_url:best?.url||''};
}
export async function enrichVideo(bytes,mimeType,identity) {
  const found=await gemini([{text:`Watch and listen to this intake video. Product already identified: ${JSON.stringify(identity)}. Read barcode/model/serial labels, spoken defects and any printed product or package dimensions/weights. Fill the backend listing fields. Use inches and pounds. Include dimension fields only when a value is legible or explicitly spoken; never invent shipping measurements. Set dims_source=verified for printed/spoken measurements, estimated only for a clear but approximate stated measurement, and omit it when no measurements exist. Condition must be one of New, Open box, Excellent, Good, Fair, For parts. Describe only supported features. eBay title maximum 80 characters. Never choose a selling price.`},
    {inlineData:{mimeType,data:bytes.toString('base64')}}],{schema:detailSchema,maxOutputTokens:2500});
  return {...found,result:{...found.value,ebay_title:String(found.value.ebay_title||'').slice(0,80)}};
}
