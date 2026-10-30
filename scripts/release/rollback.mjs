#!/usr/bin/env node
/**
 * Point production back at the previous release commit.
 * Moves origin/release with --force-with-lease. The daily job never does that.
 * Restores the Netlify deploy for that commit. Does not roll back migrations.
 */
import { git, gitOut } from "./git.mjs";
import { sendReleaseMail } from "./mail.mjs";
import { redact } from "./plan.mjs";
import { PREVIOUS_TAG, RELEASE_BRANCH, SITES } from "./sites.mjs";

const confirm = process.env.ROLLBACK_CONFIRM || "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fail(subject, text) {
  console.error(subject);
  console.error(text);
  try {
    await sendReleaseMail({ subject, text });
  } catch (err) {
    console.error(`email failed: ${redact(err?.message || err)}`);
  }
  process.exit(1);
}

async function netlify(path, { method = "GET" } = {}) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error("NETLIFY_AUTH_TOKEN is not set");
  const res = await fetch(`https://api.netlify.com/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    method,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`netlify ${method} ${path} ${res.status}: ${redact(body).slice(0, 400)}`);
  return body ? JSON.parse(body) : {};
}

function readyDeploy(deploys, sha) {
  return (deploys || []).find((deploy) => {
    if (deploy.context && deploy.context !== "production") return false;
    if (deploy.state !== "ready") return false;
    return String(deploy.commit_ref || "").startsWith(sha);
  });
}

async function main() {
  if (confirm !== "rollback") {
    console.error('Refusing rollback. Re-run the workflow and type rollback in the confirm box.');
    process.exit(1);
  }

  git(["fetch", "origin", RELEASE_BRANCH, `refs/tags/${PREVIOUS_TAG}:refs/tags/${PREVIOUS_TAG}`]);
  const current = gitOut(["rev-parse", `origin/${RELEASE_BRANCH}`]);
  const previousRef = git(["rev-parse", "--verify", `refs/tags/${PREVIOUS_TAG}`], { allowFailure: true });
  if (previousRef.status !== 0) {
    await fail(
      "[Floor] Rollback aborted: no previous release recorded",
      "The floor-release-previous tag is missing. Production was not changed. Migrations were not touched.",
    );
  }
  const previous = previousRef.stdout.trim();
  if (previous === current) {
    await fail(
      "[Floor] Rollback aborted: already at the previous release",
      `release is already ${current}. Nothing was moved. Migrations were not touched.`,
    );
  }

  const restored = [];
  for (const site of SITES) {
    const deploys = await netlify(`/sites/${site.id}/deploys?per_page=40`);
    const deploy = readyDeploy(deploys, previous);
    if (!deploy) {
      restored.push(`${site.label}: no ready production deploy for ${previous.slice(0, 7)} (left as-is)`);
      continue;
    }
    const published = await netlify(`/sites/${site.id}`);
    if (published.published_deploy?.id === deploy.id) {
      restored.push(`${site.label}: already publishing ${previous.slice(0, 7)}`);
      continue;
    }
    await netlify(`/deploys/${deploy.id}/restore`, { method: "POST" });
    restored.push(`${site.label}: restored deploy ${deploy.id} (${previous.slice(0, 7)})`);
  }

  const pushed = git(
    ["push", "origin", `--force-with-lease=refs/heads/${RELEASE_BRANCH}:${current}`, `${previous}:refs/heads/${RELEASE_BRANCH}`],
    { allowFailure: true },
  );
  if (pushed.status !== 0) {
    await fail(
      "[Floor] Rollback incomplete: Netlify may have moved, git did not",
      [
        "Migrations were not rolled back.",
        ...restored,
        redact(pushed.stderr || pushed.stdout),
      ].join("\n"),
    );
  }

  await sleep(2000);
  const text = [
    `Production git branch release now points at ${previous}.`,
    `It had been ${current}.`,
    "",
    "Migrations were NOT rolled back. The database may be ahead of this code.",
    "The next daily release will publish current master again unless master is fixed first.",
    "",
    "Netlify:",
    ...restored.map((line) => `- ${line}`),
  ].join("\n");
  await sendReleaseMail({ subject: `[Floor] Rolled back to ${previous.slice(0, 7)}`, text });
  console.log(text);
}

main().catch(async (err) => {
  await fail("[Floor] Rollback aborted", redact(err?.stack || err?.message || err));
});
