import sharp from "sharp";

const hosts = ["costco.com","homedepot.com","lowes.com","bestbuy.com","walmart.com","target.com","amazon.com","abt.com","tcgplayer.com","pokemoncenter.com","pokemon.com","hasbro.com","mattel.com","paniniamerica.net","lg.com","samsung.com","bosch-home.com","frigidaire.com","midea.com","ninja.com","cuisinart.com","gourmia.com","kohler.com","sears.com","ashleyfurniture.com","store.ashley.sa","wayfair.com","macys.com","thebrick.com","qvc.com"];
const stop = new Set("the a an and with for from in on of by new product shop buy sale store item online official".split(" "));
const colors = new Set("black white stainless silver gold blue pink green red gray grey beige heather bronze brown matte brushed".split(" "));
const fetchOptions = { headers: { "user-agent": "Mozilla/5.0 (compatible; FloorProductMatcher/1.0)" } };
const clean = (s) => String(s || "").replace(/<[^>]+>/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g," ").trim();
const words = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g," ").split(" ").filter((x) => x.length > 1 && !stop.has(x));
const clamp = (n) => Math.max(0,Math.min(1,n));
const hostAllowed = (url) => { try { const h=new URL(url).hostname.toLowerCase(); return hosts.some((v)=>h===v||h.endsWith(`.${v}`)); } catch { return false; } };
const meta = (html,key) => [...html.matchAll(/<meta\s+[^>]*>/gi)].map((m)=>m[0]).find((tag)=>tag.includes(`name="${key}"`)||tag.includes(`property="${key}"`))?.match(/content="([^"]*)"/i)?.[1] || "";

export function productQuery(unit) {
  const rawBrand=clean(unit.brand);
  const brand=new Set(["costco","walmart","target","amazon","best buy","home depot","lowes"]).has(rawBrand.toLowerCase())?"":rawBrand;
  const model=clean(unit.model);
  const title=clean(unit.title);
  // Floor's model field is often a free-form label. Keep the descriptive title,
  // and only add model when it looks like a distinct product code.
  const code=/[a-z]/i.test(model)&&/\d/.test(model)&&!title.toLowerCase().includes(model.toLowerCase()) ? model : "";
  return [brand,title||model,code].filter(Boolean).join(" ").slice(0,160);
}

export function titleScore(query,title) {
  const a=[...new Set(words(query))],b=new Set(words(title));
  if (!a.length || !b.size) return 0;
  let matched=0,total=0;
  for (const word of a) { const weight=/\d/.test(word)?2:1; total+=weight; if(b.has(word)) matched+=weight; }
  let score=matched/total;
  const qa=a.filter((x)=>colors.has(x)),ca=[...b].filter((x)=>colors.has(x));
  if(qa.length && ca.length && !qa.some((x)=>ca.includes(x))) score*=0.55;
  return clamp(score);
}

export async function searchProductImages(query) {
  const page=await fetch(`https://duckduckgo.com/?iax=images&ia=images&q=${encodeURIComponent(query)}`,{...fetchOptions,signal:AbortSignal.timeout(12000)});
  if(!page.ok) throw new Error(`search_page_${page.status}`);
  const token=(await page.text()).match(/vqd="([^"]+)"/)?.[1];
  if(!token) throw new Error("search_token_unavailable");
  const endpoint=`https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(token)}&f=,,,&p=1`;
  const result=await fetch(endpoint,{headers:{...fetchOptions.headers,referer:"https://duckduckgo.com/"},signal:AbortSignal.timeout(15000)});
  if(!result.ok) throw new Error(`image_search_${result.status}`);
  const data=await result.json();
  return (data.results||[]).filter((x)=>hostAllowed(x.url)&&/^https?:/.test(x.image||""))
    .map((x)=>({url:x.url,image:x.image,title:clean(x.title),text_score:titleScore(query,x.title)}))
    .filter((x)=>x.text_score>=0.35)
    .sort((a,b)=>b.text_score-a.text_score).slice(0,16);
}

export async function imageBytes(url) {
  const result=await fetch(url,{...fetchOptions,signal:AbortSignal.timeout(15000)});
  if(!result.ok) throw new Error(`image_${result.status}`);
  const bytes=Buffer.from(await result.arrayBuffer());
  if(bytes.length>12_000_000) throw new Error("image_too_large");
  const info=await sharp(bytes).metadata();
  if(!info.width||!info.height||info.width<250||info.height<250) throw new Error("image_too_small");
  return bytes;
}

async function fingerprint(bytes,angle=0) {
  const pipeline=sharp(bytes).rotate();
  if(angle) pipeline.rotate(angle);
  const {data}=await pipeline.resize(32,32,{fit:"contain",background:"#ffffff"}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const gray=[];const hist=new Float64Array(64);
  for(let i=0;i<data.length;i+=3){const r=data[i],g=data[i+1],b=data[i+2];gray.push(0.299*r+0.587*g+0.114*b);if(Math.min(r,g,b)<235)hist[((r>>6)<<4)|((g>>6)<<2)|(b>>6)]++;}
  const bits=[];for(let y=0;y<8;y++)for(let x=0;x<8;x++)bits.push(gray[(y*4)*32+x*4]>gray[(y*4)*32+x*4+3]?1:0);
  return {bits,hist};
}

function similarity(a,b){let same=0,dot=0,aa=0,bb=0;for(let i=0;i<64;i++){if(a.bits[i]===b.bits[i])same++;dot+=a.hist[i]*b.hist[i];aa+=a.hist[i]**2;bb+=b.hist[i]**2;}return clamp(0.65*same/64+0.35*(aa&&bb?dot/Math.sqrt(aa*bb):0));}

export async function visualScore(own,candidate){const a=await fingerprint(own);let best=0;for(const angle of [0,90,180,270])best=Math.max(best,similarity(a,await fingerprint(candidate,angle)));return best;}

export async function sourceDetails(result){
  try{
    const response=await fetch(result.url,{...fetchOptions,signal:AbortSignal.timeout(12000)});
    if(!response.ok||!String(response.headers.get("content-type")).includes("text/html"))throw new Error("no_page");
    const html=await response.text();let title=clean(meta(html,"og:title")||html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||result.title);
    if(/robot or human|access denied|costco same-day|questions and answers/i.test(title))title=result.title;
    let description=clean(meta(html,"description")||meta(html,"og:description"));
    if(/robot or human|access denied|costco favorites delivered|shop .* at the amazon|questions and answers/i.test(description))description="";
    const specs={features:[]};
    for(const match of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)){
      try{const parsed=JSON.parse(match[1]);const nodes=Array.isArray(parsed)?parsed:[parsed];for(const node of nodes){const product=node?.["@type"]==="Product"?node:node?.["@graph"]?.find((x)=>x["@type"]==="Product");if(!product)continue;
        for(const [from,to] of [["color","finish"],["material","material"],["width","width_in"],["height","height_in"],["depth","depth_in"]])if(product[from]&&typeof product[from]==="string")specs[to]=product[from].slice(0,80);
        for(const prop of product.additionalProperty||[]){if(prop?.name&&prop?.value&&specs.features.length<8)specs.features.push(`${clean(prop.name)}: ${clean(prop.value)}`.slice(0,120));}
      }}catch{/* Ignore malformed retailer data. */}
    }
    if(description.startsWith(title+","))specs.features=description.slice(title.length+1).split(/,\s*/).map(clean).filter((x)=>x.length>8).slice(0,8);
    const summary=description&&description.length>35?description.slice(0,500):title;
    return {title,description:summary,specs};
  }catch{return {title:result.title,description:result.title,specs:{features:[]}};}
}
