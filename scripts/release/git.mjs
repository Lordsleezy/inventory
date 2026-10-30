import { spawnSync } from "node:child_process";

export function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail.slice(0, 800)}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

export function gitOut(args) {
  return git(args).stdout.trim();
}
