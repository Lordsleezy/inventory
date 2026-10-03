import { createHash } from 'node:crypto';
import { requireEnv } from './server.mjs';

const MODEL = () => process.env.GEMINI_VIDEO_MODEL || 'gemini-3.8-flash';
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const visionSchema = {
  type:'object',properties:{brand:{type:'string'},model:{type:'string'},title:{type:'string'},
    category:{type:'string'},condition:{type:'string'},condition_notes:{type:'string'},
    upc:{type:'string'},mfr_serial:{type:'string'},color:{type:'string'},
    confidence:{type:'number'},uncertain_fields:{type:'array',items:{type:'string'}},
    options:{type:'array',items:{type:'object',properties:{label:{type:'string'},brand:{type:'string'},model:{type:'string'},color:{type:'string'}}}}},
  required:['brand','model','title','category','condition','condition_notes','upc','mfr_serial','color','confidence','uncertain_fields','options']
};
const lookupSchema = {
  type:'object',properties:{description:{type:'string'},key_features:{type:'array',items:{type:'string'}},
    ebay_title:{type:'string'},ebay_category:{type:'string'},ebay_item_specifics:{type:'object',additionalProperties:{type:'string'}},
    retail_prices:{type:'array',items:{type:'object',properties:{store:{type:'string'},price_cents:{type:'integer'},url:{type:'string'},exact_match:{type:'boolean'}},required:['store','price_cents','url','exact_match']}},
    uncertain_fields:{type:'array',items:{type:'string'}}},
  required:['description','key_features','ebay_title','ebay_category','ebay_item_specifics','retail_prices','uncertain_fields']
};

function checkResponse(response, structured=true) {
  const text = response.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error(`Gemini returned no text: ${response.error?.message || response.promptFeedback?.blockReason || 'empty response'}`);
  const value = structured ? JSON.parse(text) : text;
  const usage = response.usageMetadata || {};
  const queries = response.candidates?.[0]?.groundingMetadata?.webSearchQueries || [];
  return {value, input:usage.promptTokenCount || 0,output:(usage.candidatesTokenCount || 0)+(usage.thoughtsTokenCount || 0),queries:queries.length};
}

async function callGemini(parts, schema, search=false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6*60_000);
  try {
    const response = await fetch(`${API}${encodeURIComponent(MODEL())}:generateContent`,{
      method:'POST',signal:controller.signal,
      headers:{'Content-Type':'application/json','x-goog-api-key':requireEnv('GEMINI_API_KEY')},
      body:JSON.stringify({contents:[{role:'user',parts}],
        ...(search?{tools:[{googleSearch:{}}]}:{}),
        generationConfig:{...(schema?{responseMimeType:'application/json',responseJsonSchema:schema}:{}),
          maxOutputTokens:search?3600:2200,thinkingConfig:{thinkingLevel:'LOW'}}})
    });
    const body=await response.json();
    if(!response.ok)throw new Error(`Gemini ${response.status}: ${body.error?.message || 'request failed'}`);
    return checkResponse(body,Boolean(schema));
  } finally {clearTimeout(timeout)}
}

function productKey(vision) {
  if(Number(vision.confidence)<0.75)return null;
  const brand=String(vision.brand||'').trim().toLowerCase();
  const identity=String(vision.model||vision.title||'').trim().toLowerCase();
  if(!brand||identity.length<4)return null;
  return createHash('sha256').update(`${brand}|${identity}|${String(vision.color||'').toLowerCase()}`).digest('hex');
}

function cleanPrices(prices) {
  return (Array.isArray(prices)?prices:[]).filter(p => p.exact_match && Number.isInteger(p.price_cents)
    && p.price_cents>0 && p.price_cents<10_000_000 && /^https:\/\//i.test(p.url || '')
    && (()=>{try{const url=new URL(p.url);return url.pathname.length>8 && !/^(support|help|about|search)\./i.test(url.hostname)
      && !/^\/(support|help|search)(\/|$)/i.test(url.pathname) && !/grounding-api-redirect|\.\.\./i.test(url.href)}catch{return false}})())
    .map(p=>({store:String(p.store||'').slice(0,80),price_cents:p.price_cents,url:String(p.url).slice(0,1500)}))
    .sort((a,b)=>b.price_cents-a.price_cents).slice(0,12);
}

export async function analyzeVideo(sb,job,bytes,mimeType='video/mp4') {
  const observed=await callGemini([
    {text:'Watch AND listen to this short store intake video. Read exact model/UPC/serial/box text and spoken defects. Identify the exact physical product, color and variant. Never invent a model. Suggest a Floor grade from New, Open box, Excellent, Good, Fair, For parts. Distinguish uncertainty and list candidate variants if ambiguous. Return only what is visible or audible.'},
    {inlineData:{mimeType,data:bytes.toString('base64')}}
  ],visionSchema);
  const vision=observed.value;
  let lookup={value:{},input:0,output:0,queries:0};
  const key=productKey(vision);
  let cacheHit=false;
  if(key){
    const cached=await sb.from('video_scan_product_cache').select('lookup,created_at').eq('store_id',job.store_id).eq('product_key',key).maybeSingle();
    if(cached.error)throw cached.error;
    if(cached.data && Date.now()-Date.parse(cached.data.created_at)<30*86400_000){
      lookup.value=cached.data.lookup;cacheHit=true;
    }
  }
  if(!cacheHit){
    try{
      const grounded=await callGemini([{text:`Use Google Search now to find current US retail prices for the exact ${vision.brand} ${vision.model} ${vision.title} ${vision.color} product. Search retailer product pages at Walmart, Target, Amazon, Best Buy, Ace, Home Depot, Lowe's and the manufacturer when relevant. For each exact listing, report store, dollar price, and the DIRECT product-page URL, not a homepage, support page, search page or Google redirect. Also return verified product features/specifications. Distinguish colors and variants; do not guess.`}],null,true);
      if(!grounded.queries)throw new Error('Google Search grounding did not run');
      const parsed=await callGemini([{text:`Convert these Google-grounded findings into the requested product listing JSON. Use ONLY the supplied findings, not memory. Include prices only where exact brand/model/color/variant and a direct retailer URL are shown. If no verifiable exact retail price, return an empty retail_prices array. eBay title maximum 80 characters. Product: ${JSON.stringify(vision)}. Grounded findings: ${String(grounded.value).slice(0,18000)}`}],lookupSchema);
      lookup={value:parsed.value,input:grounded.input+parsed.input,output:grounded.output+parsed.output,queries:grounded.queries};
      if(key && lookup.value.retail_prices?.length){
        const saved=await sb.from('video_scan_product_cache').upsert({store_id:job.store_id,product_key:key,lookup:lookup.value,created_at:new Date().toISOString()});
        if(saved.error)throw saved.error;
      }
    }catch(error){lookup.value={description:'',key_features:[],ebay_title:'',ebay_category:'',ebay_item_specifics:{},retail_prices:[],uncertain_fields:['online lookup failed: '+error.message]}}
  }
  const prices=cleanPrices(lookup.value.retail_prices);
  const highest=prices[0];
  const result={...vision,...lookup.value,
    title:String(vision.title||'').slice(0,240),ebay_title:String(lookup.value.ebay_title||'').slice(0,80),
    retail_prices:prices,msrp_cents:highest?.price_cents||null,
    retail_source_name:highest?.store||'',retail_source_url:highest?.url||'',
    uncertain_fields:[...new Set([...(vision.uncertain_fields||[]),...(lookup.value.uncertain_fields||[]),
      ...(!highest?['retail price: no verified product listing']:[])])],
    lookup_reused:cacheHit};
  const input=observed.input+lookup.input,output=observed.output+lookup.output,queries=observed.queries+lookup.queries;
  // Conservative billed estimate: introductory Gemini 3.8 Flash rates plus all Search queries at post-free-tier price.
  const estimatedCost=Number((input*0.75/1e6+output*3.75/1e6+queries*0.014).toFixed(5));
  return {result,input,output,queries,estimatedCost,model:MODEL()};
}
