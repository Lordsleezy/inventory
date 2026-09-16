import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseCsv } from "./csv.ts";
import { guessColumnMap, parseImportRow } from "./map.ts";

test("parses quoted CSV titles and guesses seed headers", () => {
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../seed_inventory.csv"), "utf8");
  const table = parseCsv(text);
  assert.equal(table.rows.length, 32);
  const map = guessColumnMap(table.headers);
  assert.equal(map.sku, "sku");
  assert.equal(map.retail, "retail_ref");
  assert.equal(map.mfrSerial, "serial");
  const row16 = parseImportRow(table.headers, table.rows[5], map, 7);
  assert.equal(row16.sku, "11116");
  assert.match(row16.title, /46 dBA/);
  const emptyAsk = parseImportRow(table.headers, table.rows[0], map, 2);
  assert.equal(emptyAsk.askCents, null);
  assert.equal(emptyAsk.condition, null);
});
