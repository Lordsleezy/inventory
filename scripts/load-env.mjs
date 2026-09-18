import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Load gitignored .env.local / .env into process.env. Does not overwrite vars already set. */
export function loadEnvLocal(root = process.cwd()) {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Z0-9_]+$/.test(key)) continue;
      if (process.env[key]) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

loadEnvLocal();
