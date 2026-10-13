import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler, floorLog } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";

const MAX_EMAILS_PER_RUN = 20;
const SEND_GAP_MS = 200; // stay under Resend's 10 req/s

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendResend({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from || !to) return { skipped: true };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: process.env.RESEND_REPLY_TO || "pgg124@gmail.com",
      subject,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`resend ${res.status}: ${body}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return { ok: true };
}

async function sendApns() {
  if (!process.env.APNS_KEY_P8) return { skipped: true };
  return { skipped: true };
}

function saleText(sku, payload) {
  const pull = Array.isArray(payload.pull_from) ? payload.pull_from.filter(Boolean) : [];
  const channel = payload.channel || "a channel";
  if (pull.length) return `SKU ${sku} sold on ${channel}. Pull it from: ${pull.join(", ")}.`;
  return `SKU ${sku} sold on ${channel}.`;
}

function isQuotaError(message) {
  return /daily_quota_exceeded|daily email sending quota/i.test(message || "");
}

function isRateLimitError(message) {
  return /rate_limit_exceeded|Too many requests/i.test(message || "");
}

function authorized(event) {
  // Scheduled Netlify runs never carry the webhook secret — that was blocking every tick.
  if (isNetlifyScheduleEvent(event)) return true;
  const secret = process.env.ALERT_WEBHOOK_SECRET;
  if (!secret) return true;
  const got = event.headers?.["x-webhook-secret"] || event.headers?.["X-Webhook-Secret"];
  return got === secret || event.queryStringParameters?.secret === secret;
}

async function suppressStaleAlerts(sb) {
  const now = new Date().toISOString();
  const nagCutoff = new Date(Date.now() - 36 * 3600_000).toISOString();
  // Sale alerts older than 2 days are noise after a backlog — don't burn Resend quota.
  const saleCutoff = new Date(Date.now() - 48 * 3600_000).toISOString();
  const [nags, sales] = await Promise.all([
    sb
      .from("alert_outbox")
      .update({ sent_at: now, error: "suppressed_stale_delist_nag" })
      .is("sent_at", null)
      .eq("kind", "delist_nag")
      .lt("created_at", nagCutoff)
      .select("id"),
    sb
      .from("alert_outbox")
      .update({ sent_at: now, error: "suppressed_stale_sale_alert" })
      .is("sent_at", null)
      .in("kind", ["sale_delist", "sale_relist"])
      .lt("created_at", saleCutoff)
      .select("id"),
  ]);
  return {
    nags: nags.error ? { error: nags.error.message } : { cleared: (nags.data || []).length },
    sales: sales.error ? { error: sales.error.message } : { cleared: (sales.data || []).length },
  };
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (!authorized(event)) return json(401, { error: "bad_secret" });

  const sb = serviceClient();
  const schedule = isNetlifyScheduleEvent(event);
  await sb.rpc("enqueue_delist_nags");
  const stale = await suppressStaleAlerts(sb);

  const { data: alerts, error } = await sb.rpc("peek_alerts", { p_limit: 80 });
  if (error) return json(500, { error: error.message });

  // Prioritize real sales over nag spam; one digest for remaining nags.
  const rows = [...(alerts || [])];
  const priority = { double_sell: 0, sale_delist: 1, web_order: 2, web_shipped: 3, sale_relist: 4, delist_nag: 9 };
  rows.sort((a, b) => (priority[a.kind] ?? 5) - (priority[b.kind] ?? 5) || String(a.created_at).localeCompare(String(b.created_at)));

  const saleLike = rows.filter((a) => a.kind !== "delist_nag");
  const nags = rows.filter((a) => a.kind === "delist_nag");

  const results = [];
  let emailsSent = 0;
  let quotaHit = false;

  async function mail(to, subject, text) {
    if (quotaHit || emailsSent >= MAX_EMAILS_PER_RUN) return { skipped: true, reason: quotaHit ? "quota" : "cap" };
    if (emailsSent) await sleep(SEND_GAP_MS);
    try {
      await sendResend({ to, subject, text });
      emailsSent++;
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isQuotaError(message)) {
        quotaHit = true;
        return { error: message, quota: true };
      }
      if (isRateLimitError(message)) {
        await sleep(1200);
        try {
          await sendResend({ to, subject, text });
          emailsSent++;
          return { ok: true, retried: true };
        } catch (err2) {
          const m2 = err2 instanceof Error ? err2.message : String(err2);
          if (isQuotaError(m2)) quotaHit = true;
          return { error: m2 };
        }
      }
      return { error: message };
    }
  }

  async function recipientsFor(alert) {
    const staff = await sb
      .from("staff")
      .select("user_id, display_name, notify_email, notify_push, delist_duty, role")
      .eq("store_id", alert.store_id);
    const users = staff.data ?? [];
    return users.filter((u) => {
      if (alert.kind === "double_sell") return u.notify_email || u.notify_push;
      if (alert.kind === "sale_delist" || alert.kind === "delist_nag") return u.delist_duty || u.role === "owner";
      if (alert.kind === "web_order") return u.role !== "staff" && u.notify_email;
      if (alert.kind === "sale_relist") return u.role === "owner" || u.notify_email;
      return false;
    });
  }

  async function emailFor(person) {
    const { data: user } = await sb.auth.admin.getUserById(person.user_id);
    const ownerEmail = (process.env.FLOOR_OWNER_EMAIL || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return person.role === "owner" ? ownerEmail || user?.user?.email : user?.user?.email;
  }

  for (const alert of saleLike) {
    if (quotaHit) {
      results.push({ id: alert.id, deferred: "daily_quota" });
      continue;
    }
    try {
      const payload = alert.payload || {};
      let subject = `Floor: SKU ${alert.sku}`;
      let text = "";
      if (alert.kind === "double_sell") {
        subject = `URGENT: double sale on SKU ${alert.sku}`;
        text = `SKU ${alert.sku} was sold twice. Do not take money. Open Incidents in Floor.`;
      } else if (alert.kind === "sale_delist") {
        text = saleText(alert.sku, payload);
        subject = `SKU ${alert.sku} sold on ${payload.channel || "a channel"}`;
      } else if (alert.kind === "web_order") {
        subject = `New web order — SKU ${alert.sku}`;
        text = `Paid online order for SKU ${alert.sku}. ${payload.buyer_name || ""} ${payload.ship_line1 || ""} ${payload.ship_city || ""} ${payload.ship_postal || ""}`.trim();
      } else if (alert.kind === "web_shipped") {
        subject = `Your order shipped (SKU ${alert.sku})`;
        text = `SKU ${alert.sku} is on the way. Tracking number: ${payload.tracking || ""}.`;
      } else if (alert.kind === "sale_relist") {
        subject = `Relist SKU ${alert.sku}`;
        text = `SKU ${alert.sku} may need relisting. ${(payload.relist_on || []).join(", ")}`;
      } else {
        text = `SKU ${alert.sku}: ${alert.kind}`;
      }

      if (alert.kind === "web_shipped" && payload.buyer_email) {
        const r = await mail(payload.buyer_email, subject, text);
        if (r.error && !r.quota) await sb.rpc("mark_alert_sent", { p_id: alert.id, p_error: r.error });
        else if (r.ok) await sb.rpc("mark_alert_sent", { p_id: alert.id, p_error: null });
        results.push({ id: alert.id, ...r, buyer: true });
        continue;
      }

      const recipients = await recipientsFor(alert);
      let sendError = null;
      let anyOk = false;
      for (const person of recipients) {
        if (person.notify_email) {
          const email = await emailFor(person);
          if (email) {
            const r = await mail(email, subject, text);
            if (r.error) sendError = r.error;
            if (r.ok) anyOk = true;
          }
        }
        if (person.notify_push) await sendApns();
      }
      if (anyOk || (!sendError && recipients.length === 0)) {
        await sb.rpc("mark_alert_sent", { p_id: alert.id, p_error: null });
        results.push({ id: alert.id, ok: true, recipients: recipients.length });
      } else if (sendError && !isQuotaError(sendError)) {
        await sb.rpc("mark_alert_sent", { p_id: alert.id, p_error: sendError });
        results.push({ id: alert.id, error: sendError });
      } else {
        results.push({ id: alert.id, deferred: "daily_quota" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sb.rpc("mark_alert_sent", { p_id: alert.id, p_error: message });
      results.push({ id: alert.id, error: message });
    }
  }

  // One digest for open delist nags instead of N emails (saves Resend quota).
  if (nags.length && !quotaHit && emailsSent < MAX_EMAILS_PER_RUN) {
    const lines = nags.slice(0, 40).map((a) => `SKU ${a.sku} · ${a.payload?.channel || "?"}`);
    const subject = `Delist reminder: ${nags.length} SKU${nags.length === 1 ? "" : "s"} still listed elsewhere`;
    const text = `These sold units still need pulling from other marketplaces:\n\n${lines.join("\n")}${
      nags.length > 40 ? `\n…and ${nags.length - 40} more` : ""
    }\n\nOpen Floor → Incidents / delist tasks.`;
    const owners = await recipientsFor(nags[0]);
    let digestOk = false;
    let digestErr = null;
    for (const person of owners) {
      if (!person.notify_email) continue;
      const email = await emailFor(person);
      if (!email) continue;
      const r = await mail(email, subject, text);
      if (r.ok) digestOk = true;
      if (r.error) digestErr = r.error;
    }
    for (const nag of nags) {
      if (digestOk) await sb.rpc("mark_alert_sent", { p_id: nag.id, p_error: null });
      else if (digestErr && !isQuotaError(digestErr)) await sb.rpc("mark_alert_sent", { p_id: nag.id, p_error: digestErr });
    }
    results.push({ digest_nags: nags.length, ok: digestOk, error: digestErr || null });
  }

  await floorLog({
    level: quotaHit ? "warn" : "info",
    event: "alerts.dispatch",
    message: `processed ${results.length} schedule=${schedule}`,
    detail: { schedule, stale, emailsSent, quotaHit, results: results.slice(0, 40) },
  });

  return json(200, {
    processed: results.length,
    emailsSent,
    quotaHit,
    stale,
    schedule,
    results,
    hint: quotaHit
      ? "Resend daily quota hit — upgrade Resend or wait until tomorrow UTC. Critical sale alerts are deferred, not dropped."
      : null,
  });
}

export const handler = wrapHandler("dispatch-alerts", handle);
