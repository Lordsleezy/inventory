import { runPhotoMatchBatch } from "../lib/photo-match-worker.mjs";
import { netlifyHandler } from "../lib/floor-log.mjs";

async function handle(event) {
  if (event?.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: "" };
  }
  const results = await runPhotoMatchBatch(1);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ results }),
  };
}

export default netlifyHandler("enrich-models", handle);
export const config = { schedule: "*/2 * * * *" };
