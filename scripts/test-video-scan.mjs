// Integration smoke test: GEMINI_API_KEY must be supplied through the process environment.
import { readFile } from 'node:fs/promises';
import { identifyFrames, lookupRetail, retailFields, enrichVideo } from '../netlify/lib/video-scan.mjs';

const path = process.argv[2];
if (!path || !process.argv[3]) throw new Error('Pass a short MP4 video path and JPEG still path');
const cache = { from() { return {
  select() { return { eq() { return { eq() { return { async maybeSingle() { return { data: null, error: null }; } }; } }; } }; },
  async upsert() { return { error: null }; }
}; } };
const started=performance.now();
const identified=await identifyFrames([await readFile(process.argv[3])]);
const identityMs=Math.round(performance.now()-started);
const retail=await lookupRetail(cache,{store_id:'test'},identified.result);
const retailMs=Math.round(performance.now()-started);
const detail=await enrichVideo(await readFile(path),'video/mp4',identified.result);
console.log(JSON.stringify({identity:identified.result,retail:retailFields(retail.prices),
  details:detail.result,identity_ms:identityMs,retail_ms:retailMs,
  search_queries:retail.queries,input_tokens:identified.input+retail.input+detail.input,
  output_tokens:identified.output+retail.output+detail.output},null,2));
