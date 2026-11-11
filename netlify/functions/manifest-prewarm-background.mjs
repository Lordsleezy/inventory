/**
 * Background prewarm worker for TRA-7096264 (or posted CSV text).
 * Invoked by manifest-prewarm. Never publishes listings.
 */
import fs from "node:fs";
import path from "node:path";
import { json, optionsOk } from "../lib/server.mjs";
import { netlifyHandler } from "../lib/floor-log.mjs";
import { prewarmFromCsvText, linesFromCleanCsv, prewarmManifestLines } from "../lib/manifest-prewarm-run.mjs";

export default netlifyHandler("manifest-prewarm-background", async (event) => {
  if (event.httpMethod === "OPTIONS") return optionsOk();
  const body = JSON.parse(event.body || "{}");
  const storeId = body.store_id;
  if (!storeId) return json(400, { ok: false, error: "store_id_required" });

  let lines = Array.isArray(body.lines) ? body.lines : null;
  if (!lines) {
    const csvText = body.csv_text || (() => {
      const candidates = [
        path.resolve("data/manifests/TRA-7096264_clean_for_floor.csv"),
        path.resolve("TRA-7096264_clean_for_floor.csv"),
      ];
      const hit = candidates.find((p) => fs.existsSync(p));
      return hit ? fs.readFileSync(hit, "utf8") : null;
    })();
    if (!csvText) return json(404, { ok: false, error: "csv_not_found" });
    lines = linesFromCleanCsv(csvText);
  }

  const offset = Number(body.offset || 0) || 0;
  const limit = Number(body.limit || 0) || 0;
  let slice = lines.slice(offset);
  if (limit > 0) slice = slice.slice(0, limit);

  const report = await prewarmManifestLines(storeId, slice, {
    force: body.force === true,
    sleepMs: Number(body.sleep_ms || 100) || 100,
    dryRun: body.dry_run === true,
  });
  return json(200, { ok: true, report });
});
