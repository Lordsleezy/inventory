import { readFile } from "node:fs/promises";
import { importPhoneBackup } from "@floor/cloud";

const file = process.argv[2];
if (!file) {
  console.error("Usage: set STORE_ID=<uuid from Setup> && set SUPABASE_URL=https://zoukmsmbztcuyoslvikp.supabase.co && node --experimental-strip-types scripts/import-phone-backup.mjs path/to/floor-backup-full.json");
  process.exit(1);
}
if (!process.env.STORE_ID) {
  console.error("Set STORE_ID to the store you created in the app. Import will not create a store.");
  process.exit(1);
}

const snapshot = JSON.parse(await readFile(file, "utf8"));
const result = await importPhoneBackup(snapshot);
console.log(JSON.stringify(result, null, 2));
