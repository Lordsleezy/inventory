/** Job names from .github/workflows/sql-tests.yml. All three must be green. */
export const REQUIRED_CHECK_NAMES = [
  "Historical fresh replay (not live) — PGlite migrations + ticket tax",
  "Live baseline — pending migrations apply on live schema",
  "Historical fresh replay (not live) — Postgres pgTAP",
];

export function redact(text) {
  return String(text ?? "")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]")
    .replace(/\b(sbp_|sbs_|re_|nfp_|ghp_|gho_|github_pat_)[A-Za-z0-9_-]+/g, "$1[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[jwt]");
}

export function migrationsFromPushOutput(text) {
  const names = [];
  for (const line of String(text).split(/\n/)) {
    const bullet = line.match(/^\s*[•*-]\s+(\S+\.sql)\s*$/);
    const named = line.match(/((?:\d{8,14}|000\d)_[A-Za-z0-9_.-]+\.sql)/);
    const hit = bullet?.[1] || named?.[1];
    if (hit && !names.includes(hit)) names.push(hit);
  }
  return names;
}

/**
 * Latest check run per name. Pending runs block a release; a completed
 * failure blocks it too. Missing required checks are not green.
 */
export function assessChecks(runs, required = REQUIRED_CHECK_NAMES) {
  const latest = new Map();
  for (const run of runs || []) {
    if (!required.includes(run.name)) continue;
    const prev = latest.get(run.name);
    const stamp = Date.parse(run.started_at || run.completed_at || 0) || 0;
    const prevStamp = prev ? Date.parse(prev.started_at || prev.completed_at || 0) || 0 : -1;
    if (!prev || stamp >= prevStamp) latest.set(run.name, run);
  }
  const missing = required.filter((name) => !latest.has(name));
  const pending = [];
  const failed = [];
  for (const name of required) {
    const run = latest.get(name);
    if (!run) continue;
    if (run.status !== "completed") pending.push(name);
    else if (run.conclusion !== "success") failed.push(`${name} (${run.conclusion || "unknown"})`);
  }
  return {
    ok: missing.length === 0 && pending.length === 0 && failed.length === 0,
    pending,
    failed,
    missing,
  };
}

/** Netlify ignore-skips are recorded as error deploys with this message. */
export function classifyDeploy(deploy) {
  if (!deploy) return "pending";
  const message = `${deploy.error_message || ""} ${deploy.title || ""}`;
  if (/no content change/i.test(message)) return "skipped";
  if (deploy.state === "ready") return "deployed";
  if (["error", "rejected"].includes(deploy.state)) return "failed";
  return "pending";
}

export function prTitlesFromLog(logText) {
  const titles = [];
  const chunks = String(logText).split(/\n---\n/);
  for (const chunk of chunks) {
    const lines = chunk.split(/\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const subject = lines[0];
    const merge = subject.match(/^Merge pull request #(\d+)\b/);
    if (merge) {
      const body = lines.slice(1).find((line) => !line.startsWith("Merge pull request"));
      titles.push(body ? `#${merge[1]} ${body}` : subject);
      continue;
    }
    if (/^Merge branch /.test(subject)) continue;
    titles.push(subject);
  }
  return titles;
}
