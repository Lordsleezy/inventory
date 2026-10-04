import { randomUUID } from "node:crypto";
import { serviceClient } from "./server.mjs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns an owner token when the named lock was free (or expired), otherwise null. */
export async function tryLock(name, ttlSeconds, sb = serviceClient()) {
  const owner = randomUUID();
  const { data, error } = await sb.rpc("try_job_lock", { p_name: name, p_owner: owner, p_ttl_seconds: ttlSeconds });
  if (error) throw new Error(`lock ${name}: ${error.message}`);
  return data === true ? owner : null;
}

export async function releaseLock(name, owner, sb = serviceClient()) {
  if (!owner) return;
  await sb.rpc("release_job_lock", { p_name: name, p_owner: owner });
}

/**
 * True when the database looks busy: the probe itself is slow, errors, or many client queries are running.
 * Background work calls this between small batches and stops early so the register, website,
 * phone app and admin portal always win.
 */
export async function dbBusy(sb = serviceClient(), { maxActive = 5, maxMs = 1500 } = {}) {
  const started = Date.now();
  const { data, error } = await sb.rpc("bg_db_probe");
  if (error) return true;
  return Date.now() - started > maxMs || Number(data?.active ?? 0) > maxActive;
}

/** Run fn only if nothing else holds the lock; always release. Returns { skipped: true } when it was held. */
export async function withLock(name, ttlSeconds, fn, sb = serviceClient()) {
  const owner = await tryLock(name, ttlSeconds, sb);
  if (!owner) return { skipped: true, reason: `${name} is already running` };
  try { return await fn(); }
  finally { await releaseLock(name, owner, sb).catch(() => undefined); }
}
