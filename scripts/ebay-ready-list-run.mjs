/**
 * List marketplace-board ready units that are not on eBay.
 *
 *   node scripts/ebay-ready-list-run.mjs
 *   node scripts/ebay-ready-list-run.mjs --dry-run
 *   node scripts/ebay-ready-list-run.mjs --skus=11701,11702
 */
import { loadEnvLocal } from "./load-env.mjs";

loadEnvLocal();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skusArg = args.find((a) => a.startsWith("--skus="));
const skus = skusArg
  ? skusArg
      .slice("--skus=".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : null;
const paceArg = args.find((a) => a.startsWith("--pace-ms="));
const paceMs = paceArg ? Number(paceArg.slice("--pace-ms=".length)) : undefined;

const { runReadyList, STORE_DEFAULT } = await import("../netlify/lib/ebay-ready-list.mjs");

const result = await runReadyList(STORE_DEFAULT, { skus, dryRun, paceMs });
console.log(result.txt);
console.log(JSON.stringify(result.summary, null, 2));
process.exit(result.summary.failed && !dryRun ? 1 : 0);
