import { writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { STORE_DEFAULT, spapiFetch, marketplaceId } from "../netlify/lib/amazon.mjs";

function loadEnv() {
  const pkgPath = "package.json";
  const original = readFileSync(pkgPath, "utf8");
  const parsed = JSON.parse(original);
  delete parsed.workspaces;
  writeFileSync(pkgPath, `${JSON.stringify(parsed, null, 2)}\n`);
  try {
    const r = spawnSync(
      process.execPath,
      [process.env.NETLIFY_CLI, "env:list", "--json", "--site", "458b95f4-4adb-4721-97bc-400f8bb97597"],
      {
        encoding: "utf8",
        env: { ...process.env, NETLIFY_SITE_ID: "458b95f4-4adb-4721-97bc-400f8bb97597", CI: "true" },
        cwd: process.cwd(),
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    return JSON.parse(r.stdout || "{}");
  } finally {
    writeFileSync(pkgPath, original);
  }
}

const envData = loadEnv();
for (const [k, v] of Object.entries(envData)) if (typeof v === "string") process.env[k] = v;

const sid = process.env.AMAZON_SELLER_ID;
const def = await spapiFetch(
  STORE_DEFAULT,
  "GET",
  `/definitions/2020-09-01/productTypes/STRING_LIGHT?marketplaceIds=${marketplaceId()}&requirements=LISTING&sellerId=${encodeURIComponent(sid)}&locale=en_US`,
);
const schemaUrl = def.schema?.link?.resource;
const schema = await (await fetch(schemaUrl)).json();
const attrs = schema.properties?.attributes?.properties || {};
const keys = [
  "cable",
  "light_source",
  "light_color",
  "indoor_outdoor_usage",
  "unit_count",
  "list_price",
  "main_product_image_locator",
  "externally_assigned_product_identifier",
  "power_source_type",
];
const extract = {};
for (const k of keys) {
  const node = attrs[k];
  if (!node) {
    extract[k] = null;
    continue;
  }
  extract[k] = {
    title: node.title,
    description: String(node.description || "").slice(0, 240),
    itemsRequired: node.items?.required || null,
    itemPropKeys: node.items?.properties ? Object.keys(node.items.properties) : null,
    valueEnum: node.items?.properties?.value?.enum || node.items?.properties?.value?.examples || null,
    typeEnum: node.items?.properties?.type?.enum || null,
    languageTag: node.items?.properties?.type?.properties?.language_tag || node.items?.properties?.language_tag || null,
    rawItemProps: node.items?.properties || null,
  };
}
writeFileSync("/tmp/string-light-attr-shapes.json", JSON.stringify(extract, null, 2));
console.log(JSON.stringify(extract, null, 2).slice(0, 15000));
