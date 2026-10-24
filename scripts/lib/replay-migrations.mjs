/**
 * Historical fresh-replay tests predate the migration versions recovered from
 * the live Floor ledger. Their original local SQL is preserved separately.
 * Production deploys use only supabase/migrations; this helper is for tests.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export function replayMigrationPaths(root) {
  const migrations = path.join(root, "supabase", "migrations");
  const legacy = path.join(root, "supabase", "unapplied-legacy-migrations");
  const recovered = new Set(
    readFileSync(path.join(root, "supabase", "tests", "recovered-live-versions.txt"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean),
  );
  const files = [
    ...readdirSync(migrations)
      .filter((name) => name.endsWith(".sql") && !recovered.has(name.split("_")[0]))
      .map((name) => path.join(migrations, name)),
    ...readdirSync(legacy)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => path.join(legacy, name)),
  ];
  files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const names = files.map((file) => path.basename(file));
  if (new Set(names).size !== names.length) throw new Error("Duplicate replay migration filename");
  return files;
}
