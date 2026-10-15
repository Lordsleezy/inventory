import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./lib/deploy-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = buildManifest(root);
const file = path.join(root, "scripts", "function-manifest.json");
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  functions: manifest.functions.length,
  scheduled: Object.keys(manifest.schedules).length,
  critical: manifest.critical.length,
}));
