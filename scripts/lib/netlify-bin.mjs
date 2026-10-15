import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function netlifyCliPath() {
  if (process.env.NETLIFY_CLI && existsSync(process.env.NETLIFY_CLI)) return process.env.NETLIFY_CLI;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "../..");
  const localCandidates = [
    path.join(repoRoot, "node_modules", "netlify-cli", "bin", "run.js"),
    path.join(repoRoot, "node_modules", "netlify-cli", "bin", "run.mjs"),
  ];
  for (const candidate of localCandidates) if (existsSync(candidate)) return candidate;
  const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).stdout.trim();
  const candidate = path.join(root, "netlify-cli", "bin", "run.js");
  return existsSync(candidate) ? candidate : null;
}

/** Spawn the Netlify CLI without a shell so JSON quotes survive. Caller passes flags. */
export function runNetlify(args, { root, site, stdio } = {}) {
  const cli = netlifyCliPath();
  if (!cli) return { status: 127, stdout: "", stderr: "netlify cli not found" };
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root || path.dirname(fileURLToPath(import.meta.url)),
    encoding: stdio === "inherit" ? undefined : "utf8",
    stdio: stdio || "pipe",
    shell: false,
    maxBuffer: 20 * 1024 * 1024,
    env: site ? { ...process.env, NETLIFY_SITE_ID: site } : process.env,
  });
}
