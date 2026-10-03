// Integration smoke test: GEMINI_API_KEY must be supplied through the process environment.
import { readFile } from 'node:fs/promises';
import { analyzeVideo } from '../netlify/lib/video-scan.mjs';

const path = process.argv[2];
if (!path) throw new Error('Pass a short MP4 video path');
const cache = { from() { return {
  select() { return { eq() { return { eq() { return { async maybeSingle() { return { data: null, error: null }; } }; } }; } }; },
  async upsert() { return { error: null }; }
}; } };
const response = await analyzeVideo(cache, { store_id: 'test' }, await readFile(path));
console.log(JSON.stringify({ result: response.result, input_tokens: response.input,
  output_tokens: response.output, search_queries: response.queries,
  estimated_cost_usd: response.estimatedCost, model: response.model }, null, 2));
