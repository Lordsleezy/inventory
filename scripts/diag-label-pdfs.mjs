#!/usr/bin/env node
/** Run: node scripts/diag-label-pdfs.mjs path/to/eBay_label.pdf … */
import { readFileSync } from "node:fs";
import { extractTrackingFromFile } from "../netlify/lib/tracking-extract.mjs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node scripts/diag-label-pdfs.mjs <label.pdf> …");
  process.exit(1);
}

for (const path of files) {
  const buf = readFileSync(path);
  const name = path.split(/[/\\]/).pop();
  const r = await extractTrackingFromFile(buf, "application/pdf", { filename: name });
  console.log(JSON.stringify({ file: name, layer: r.layer, confident: r.confident, number: r.number, carrier: r.carrier, reason: r.reason }, null, 2));
}
