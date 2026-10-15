/**
 * Backend log viewer for the admin portal, plus a way for the portal itself to report failures it
 * hit in the browser (so a click that "does nothing" always leaves a trace).
 *   action: "list"         filters + errors-by-source summary + requests that never finished
 *   action: "client_error" browser-side failure report (rate limited)
 */
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { floorLog, redact, asNetlifyFunction } from "../lib/floor-log.mjs";
import { SCHEDULED_JOBS } from "../lib/schedule.mjs";

const like = (s) => String(s).replace(/[%_,()]/g, " ").trim();

/** Last successful/failed run per scheduled job, for the Logs → Jobs panel. */
export async function jobHealth(sb, storeId) {
  const sources = SCHEDULED_JOBS.map((j) => j.source);
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const { data, error } = await sb
    .from("floor_logs")
    .select("source,created_at,level,event,message,detail")
    .or(`store_id.eq.${storeId},store_id.is.null`)
    .in("source", sources)
    .in("event", ["fn.end", "fn.crash", "alerts.dispatch"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(800);
  if (error) throw new Error(error.message);
  const latest = new Map();
  for (const row of data || []) {
    if (!latest.has(row.source)) latest.set(row.source, row);
  }
  const now = Date.now();
  return SCHEDULED_JOBS.map((job) => {
    const row = latest.get(job.source);
    const lastAt = row?.created_at ? new Date(row.created_at).getTime() : null;
    const ageMin = lastAt != null ? (now - lastAt) / 60_000 : null;
    // Daily jobs: red after 36h; others: red after 2.5× expected interval (min 10 min).
    const staleAfter = job.everyMin >= 1440 ? 36 * 60 : Math.max(10, job.everyMin * 2.5);
    const overdue = ageMin == null || ageMin > staleAfter;
    const statusCode = row?.detail?.status ?? (row?.event === "fn.crash" ? 500 : null);
    const ok = row && row.level !== "error" && row.event !== "fn.crash" && !(statusCode >= 400);
    return {
      source: job.source,
      label: job.label,
      cron: job.cron,
      everyMin: job.everyMin,
      lastRunAt: row?.created_at || null,
      ageMin: ageMin != null ? Math.round(ageMin) : null,
      level: row?.level || null,
      message: row?.message || null,
      status: !row ? "never" : overdue ? "stale" : ok ? "ok" : "error",
      overdue,
    };
  });
}

export async function listLogs(sb, storeId, p = {}) {
  const limit = Math.min(200, Math.max(1, Number(p.limit) || 80));
  let q = sb.from("floor_logs").select("id,created_at,store_id,sku,trace_id,source,level,event,message,detail")
    .or(`store_id.eq.${storeId},store_id.is.null`).order("created_at", { ascending: false }).limit(limit);
  if (p.level === "error") q = q.eq("level", "error");
  else if (p.level === "problems") q = q.in("level", ["error", "warn"]);
  if (!p.includeStarts && !p.traceId) q = q.neq("event", "fn.start");
  if (p.source) q = q.eq("source", String(p.source));
  if (p.sku) q = q.eq("sku", String(p.sku).trim());
  if (p.traceId) q = q.eq("trace_id", String(p.traceId).trim());
  if (p.q && like(p.q)) q = q.ilike("message", `%${like(p.q)}%`);
  if (p.before) q = q.lt("created_at", String(p.before));
  if (p.sinceMinutes) q = q.gte("created_at", new Date(Date.now() - Number(p.sinceMinutes) * 60_000).toISOString());
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

export async function summary(sb, storeId) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data } = await sb.from("floor_logs").select("source,level")
    .or(`store_id.eq.${storeId},store_id.is.null`).in("level", ["error", "warn"]).gte("created_at", since).limit(2000);
  const bySource = {};
  for (const row of data || []) {
    const e = (bySource[row.source] ||= { source: row.source, errors: 0, warnings: 0 });
    if (row.level === "error") e.errors++; else e.warnings++;
  }
  return Object.values(bySource).sort((a, b) => b.errors - a.errors || b.warnings - a.warnings);
}

/** Requests that started 90 seconds to 2 hours ago and never logged an end: killed or timed out. */
export async function stalled(sb, storeId) {
  const from = new Date(Date.now() - 2 * 3600_000).toISOString();
  const to = new Date(Date.now() - 90_000).toISOString();
  const { data: starts } = await sb.from("floor_logs").select("trace_id,created_at,source,message,detail,sku")
    .or(`store_id.eq.${storeId},store_id.is.null`).eq("event", "fn.start").gte("created_at", from).lte("created_at", to)
    .order("created_at", { ascending: false }).limit(300);
  if (!starts?.length) return [];
  const { data: ends } = await sb.from("floor_logs").select("trace_id").in("event", ["fn.end", "fn.crash"]).in("trace_id", starts.map((r) => r.trace_id));
  const done = new Set((ends || []).map((r) => r.trace_id));
  return starts.filter((r) => !done.has(r.trace_id)).slice(0, 40).map((r) => ({
    trace_id: r.trace_id, created_at: r.created_at, source: r.source, sku: r.sku,
    action: r.detail?.body?.action || null,
  }));
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  let ctx;
  const body = JSON.parse(event.body || "{}");
  try { ctx = await portalAdminFromEvent(event, body.store_id); }
  catch (err) { return json(err.status || 401, { error: err.message }); }
  const { sb, storeId, actor } = ctx;
  if (body.action === "client_error") {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await sb.from("floor_logs").select("id", { count: "exact", head: true }).eq("source", "admin-ui").gte("created_at", since);
    if ((count || 0) >= 30) return json(429, { ok: false, error: "too_many_reports" });
    await floorLog({
      level: "error", event: "client.error", source: "admin-ui", storeId, sku: body.sku ? String(body.sku).slice(0, 40) : undefined,
      message: String(body.message || "browser error").slice(0, 500),
      detail: redact({ actor, page: body.page, url: body.url, status: body.status ?? null, traceId: body.traceId ?? null, action: body.action_name ?? null, ua: String(event.headers?.["user-agent"] || "").slice(0, 160) }),
    });
    return json(200, { ok: true });
  }
  const [logs, summaryRows, stalledRows, jobs] = await Promise.all([
    listLogs(sb, storeId, body),
    body.light ? [] : summary(sb, storeId),
    body.light ? [] : stalled(sb, storeId),
    body.light ? [] : jobHealth(sb, storeId),
  ]);
  return json(200, { ok: true, logs, summary: summaryRows, stalled: stalledRows, jobs });
}

export const invoke = async (event) => {
  try { return await handle(event); }
  catch (err) { return json(500, { error: err instanceof Error ? err.message : String(err) }); }
};

export default asNetlifyFunction(invoke);
