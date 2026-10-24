import path from "node:path";
import { fileURLToPath } from "node:url";
import { replayMigrationPaths } from "./lib/replay-migrations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of replayMigrationPaths(root)) console.log(file);
