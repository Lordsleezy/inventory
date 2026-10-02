import { runPhotoMatchBatch } from "../lib/photo-match-worker.mjs";

export default async function handler() {
  const results = await runPhotoMatchBatch(1);
  return new Response(JSON.stringify({ results }), { headers: { "content-type": "application/json" } });
}

export const config = { schedule: "*/2 * * * *" };
