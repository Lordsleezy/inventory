#!/usr/bin/env node
/**
 * Cheap Netlify-functions bundle check (no deploy).
 *
 * Catches the esbuild "duplicate symbol" failure mode where a file both
 * declares `function handler` and `export const handler = …` — the bug that
 * aborted the inventoryobi functions site while admin still published.
 *
 * Mirrors Netlify's `node_bundler = "esbuild"` enough to fail the same way:
 * bundle each entry with esbuild, keep node_modules external, write nothing.
 */
import { build } from "esbuild";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const functionsDir = path.join(root, "netlify", "functions");

const COLLISION = /(?:async\s+)?function\s+handler\b[\s\S]*\bexport\s+const\s+handler\b|\bexport\s+const\s+handler\b[\s\S]*(?:async\s+)?function\s+handler\b/;
const LAMBDA_EXPORT = /export\s+(?:async\s+)?function\s+handler\b|export\s+const\s+handler\b|exports\.handler\s*=/;

const files = readdirSync(functionsDir)
  .filter((name) => name.endsWith(".mjs") || name.endsWith(".js"))
  .sort();

const staticErrors = [];
for (const name of files) {
  const source = readFileSync(path.join(functionsDir, name), "utf8");
  if (COLLISION.test(source)) {
    staticErrors.push(`${name}: handler declared twice (function handler + export const handler)`);
  }
  if (LAMBDA_EXPORT.test(source)) {
    staticErrors.push(`${name}: legacy Lambda handler export (use export default)`);
  }
  if (!/export\s+default\b/.test(source)) {
    staticErrors.push(`${name}: missing export default`);
  }
}

if (staticErrors.length) {
  console.error(JSON.stringify({ ok: false, stage: "static", errors: staticErrors }, null, 2));
  process.exit(1);
}

const bundleErrors = [];
for (const name of files) {
  const entry = path.join(functionsDir, name);
  try {
    await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "silent",
      // Match Netlify enough to compile local imports; leave packages external
      // so CI stays cheap and does not need native deps like sharp.
      packages: "external",
    });
  } catch (err) {
    const text = String(err?.errors?.[0]?.text || err?.message || err);
    bundleErrors.push(`${name}: ${text.split("\n")[0]}`);
  }
}

if (bundleErrors.length) {
  console.error(JSON.stringify({ ok: false, stage: "esbuild", errors: bundleErrors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, functions: files.length, bundler: "esbuild", packages: "external" }));
