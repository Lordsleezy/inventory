import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeNetlifyOutput } from './netlify-output.mjs';

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

/** CLI 27 dropped the global --cwd flag. The spawn cwd is the repo root. */
function argsWithoutCwd(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--cwd") {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/**
 * Netlify CLI 27 treats an npm-workspace root as a monorepo and asks which
 * package to build. This functions site is the repository root, so hide
 * workspaces for the duration of the CLI call and put the file back after.
 */
function withoutWorkspaces(cwd, fn) {
  const pkgPath = path.join(cwd, "package.json");
  if (!existsSync(pkgPath)) return fn();
  const original = readFileSync(pkgPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(original);
  } catch {
    return fn();
  }
  if (!parsed.workspaces) return fn();
  const hidden = { ...parsed };
  delete hidden.workspaces;
  writeFileSync(pkgPath, `${JSON.stringify(hidden, null, 2)}\n`);
  try {
    return fn();
  } finally {
    writeFileSync(pkgPath, original);
  }
}

/** Spawn the Netlify CLI without a shell so JSON quotes survive. Caller passes flags. */
export function runNetlify(args, { root, site, stdio } = {}) {
  const cli = netlifyCliPath();
  if (!cli) return { status: 127, stdout: "", stderr: "netlify cli not found" };
  const cwd = root || path.dirname(fileURLToPath(import.meta.url));
  const result = withoutWorkspaces(cwd, () => spawnSync(process.execPath, [cli, ...argsWithoutCwd(args)], {
    cwd,
    encoding: "utf8",
    stdio: stdio === 'inherit' ? 'pipe' : stdio || "pipe",
    shell: false,
    maxBuffer: 20 * 1024 * 1024,
    env: site ? { ...process.env, NETLIFY_SITE_ID: site, CI: process.env.CI || "true" } : { ...process.env, CI: process.env.CI || "true" },
  }));
  if (stdio === 'inherit') {
    process.stdout.write(safeNetlifyOutput(result.stdout));
    process.stderr.write(safeNetlifyOutput(result.stderr));
  }
  return result;
}
