import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler, floorLog, asNetlifyFunction } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { sendInternalAlert, gmailConfigured, isDeliverableEmail, filterDeliverableEmails } from "../lib/mail.mjs";
import { sendResend } from "../lib/receipt.mjs";

// Internal alerts (sales, delist digests, double-sell, web-order pings) go through Gmail SMTP
// (GMAIL_SMTP_USER + GMAIL_SMTP_APP_PASSWORD). Only web_shipped buyer emails use Resend.
const MAX_EMAILS_PER_RUN = 20;
const SEND_GAP_MS = 200; // gentle pacing for both Gmail SMTP and Resend (10 req/s)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendApns() {
  if (!process.env.APNS_KEY_P8) return { skipped: true };
  return { skipped: true };
}

const CHANNEL_NAMES = {
  ebay: "eBay",
  depop: "Depop",
  mercari: "Mercari",
  poshmark: "Poshmark",
  facebook: "Facebook",
  etsy: "Etsy",
  grailed: "Grailed",
  vinted: "Vinted",
  vestiaire_collective: "Vestiaire Collective",
  shopify: "Shopify",
  vendoo: "Vendoo",
  amazon: "Amazon",
  website: "Website",
  tiktok: "TikTok",
};

function channelName(key) {
  const k = String(key || "").trim();
  if (!k) return "a channel";
  return CHANNEL_NAMES[k.toLowerCase()] || k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ");
}

function pullList(payload) {
  return Array.isArray(payload?.pull_from) ? payload.pull_from.filter(Boolean).map(channelName) : [];
}

function shortTitle(title, max = 42) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function dollars(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return "";
  const n = Number(cents) / 100;
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

/** `SOLD on Depop – Title $69 (11449) – delist Mercari` (delist part only when pull_from is present). */
function soldOn(payload) {
  const name = channelName(payload?.channel);
  return payload?.local_pickup ? `${name} LOCAL PICKUP` : name;
}

function saleSubject(sku, title, payload) {
  const pull = pullList(payload);
  const price = dollars(payload?.price_cents);
  const what = [shortTitle(title), price].filter(Boolean).join(" ");
  let subject = `SOLD on ${soldOn(payload)} – ${what ? `${what} ` : ""}(${sku})`;
  if (pull.length) subject += ` – delist ${pull.join(", ")}`;
  return subject;
}

function saleText(sku, title, payload) {
  const pull = pullList(payload);
  const price = dollars(payload?.price_cents);
  const lines = [
    `SKU ${sku}${title ? ` – ${title}` : ""} sold on ${soldOn(payload)}${price ? ` for ${price}` : ""}.`,
  ];
  if (payload?.receipt_no) lines.push(`Receipt: ${payload.receipt_no}`);
  lines.push(pull.length ? `Pull it from: ${pull.join(", ")}.` : "Nothing else to pull down.");
  return lines.join("\n");
}

function isQuotaError(message) {
  // Resend daily quota and Gmail SMTP daily sending limit (550 5.4.5).
  return /daily_quota_exceeded|daily email sending quota|daily user sending (?:limit|quota)|5\.4\.5|sending limit exceeded/i.test(message || "");
}

function isRateLimitError(message) {
  return /rate_limit_exceeded|Too many requests|\b421\b.*4\.7\.0|too many login attempts|try again later/i.test(message || "");
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
  // Sale alerts older than 2 days are noise after a backlog — don't burn email quota.
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
  let quotaHit = false; // Gmail SMTP (internal alerts)
  let resendQuotaHit = false; // Resend (buyer shipped emails)

  // via "gmail" = internal alert (default); via "resend" = customer email.
  async function deliver(via, to, subject, text) {
    if (via === "resend") return sendResend({ to, subject, text });
    return sendInternalAlert({ to, subject, text });
  }

  async function mail(to, subject, text, via = "gmail") {
    const hit = via === "resend" ? resendQuotaHit : quotaHit;
    const markQuota = () => {
      if (via === "resend") resendQuotaHit = true;
      else quotaHit = true;
    };
    if (hit || emailsSent >= MAX_EMAILS_PER_RUN) return { skipped: true, reason: hit ? "quota" : "cap" };
    if (emailsSent) await sleep(SEND_GAP_MS);
    try {
      const sent = await deliver(via, to, subject, text);
      // Not configured (or nobody to send to): leave the alert queued instead of marking it sent.
      if (sent?.skipped) return { skipped: true, reason: sent.reason || "not_configured" };
      emailsSent++;
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isQuotaError(message)) {
        markQuota();
        return { error: message, quota: true };
      }
      if (isRateLimitError(message)) {
        await sleep(1200);
        try {
          const sent = await deliver(via, to, subject, text);
          if (sent?.skipped) return { skipped: true, reason: sent.reason || "not_configured" };
          emailsSent++;
          return { ok: true, retried: true };
        } catch (err2) {
          const m2 = err2 instanceof Error ? err2.message : String(err2);
          if (isQuotaError(m2)) markQuota();
          return { error: m2 };
        }
      }
      return { error: message };
    }
  }

  // Product titles for scannable subjects (alert payloads only carry SKU + channel + price).
  const titleKey = (storeId, sku) => `${storeId}:${sku}`;
  const titles = new Map();
  const wantSkus = [...new Set(rows.map((a) => a.sku).filter(Boolean))];
  if (wantSkus.length) {
    const { data: units } = await sb.from("units").select("store_id, sku, title").in("sku", wantSkus);
    for (const u of units || []) titles.set(titleKey(u.store_id, u.sku), u.title || "");
  }
  const titleOf = (alert) => titles.get(titleKey(alert.store_id, alert.sku)) || "";

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

  async function emailFor(person, storeId) {
    // Owners: prefer real notify list / FLOOR_OWNER_EMAIL over auth login emails.
    if (person.role === "owner") {
      const fromEnv = filterDeliverableEmails((process.env.FLOOR_OWNER_EMAIL || "").split(","));
      if (fromEnv[0]) return fromEnv[0];
      let cfgQ = sb.from("store_settings").select("value").eq("key", "order_notify_emails");
      if (storeId) cfgQ = cfgQ.eq("store_id", storeId);
      const { data: cfg } = await cfgQ.maybeSingle();
      const fromSettings = filterDeliverableEmails(Array.isArray(cfg?.value) ? cfg.value : []);
      if (fromSettings[0]) return fromSettings[0];
    }
    const { data: user } = await sb.auth.admin.getUserById(person.user_id);
    const authEmail = user?.user?.email || null;
    // Drop PIN-login aliases like local@employees.floor.local (NXDOMAIN bounces).
    return isDeliverableEmail(authEmail) ? authEmail : null;
  }

  for (const alert of saleLike) {
    if (alert.kind === "web_shipped" ? resendQuotaHit : quotaHit) {
      results.push({ id: alert.id, deferred: "daily_quota" });
      continue;
    }
    try {
      const payload = alert.payload || {};
      const title = titleOf(alert);
      const label = shortTitle(title);
      let subject = `Floor: SKU ${alert.sku}`;
      let text = "";
      if (alert.kind === "double_sell") {
        subject = `URGENT double sale – ${label ? `${label} ` : ""}(${alert.sku})`;
        text = `SKU ${alert.sku}${title ? ` – ${title}` : ""} was sold twice. Do not take money. Open Incidents in Floor.`;
      } else if (alert.kind === "sale_delist") {
        text = saleText(alert.sku, title, payload);
        subject = saleSubject(alert.sku, title, payload);
      } else if (alert.kind === "web_order") {
        subject = `NEW WEB ORDER – ${label ? `${label} ` : ""}(${alert.sku})`;
        text = `Paid online order for SKU ${alert.sku}${title ? ` – ${title}` : ""}. ${payload.buyer_name || ""} ${payload.ship_line1 || ""} ${payload.ship_city || ""} ${payload.ship_postal || ""}`.trim();
      } else if (alert.kind === "web_shipped") {
        // Customer-facing: keep the plain wording (sent through Resend).
        subject = `Your order shipped (SKU ${alert.sku})`;
        text = `SKU ${alert.sku} is on the way. Tracking number: ${payload.tracking || ""}.`;
      } else if (alert.kind === "sale_relist") {
        const relist = (payload.relist_on || []).filter(Boolean).map(channelName);
        subject = `RELIST – ${label ? `${label} ` : ""}(${alert.sku})${relist.length ? ` – ${relist.join(", ")}` : ""}`;
        text = `SKU ${alert.sku}${title ? ` – ${title}` : ""} may need relisting.${relist.length ? ` ${relist.join(", ")}` : ""}`;
      } else {
        text = `SKU ${alert.sku}: ${alert.kind}`;
      }

      if (alert.kind === "web_shipped" && payload.buyer_email) {
        const r = await mail(payload.buyer_email, subject, text, "resend");
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
          const email = await emailFor(person, alert.store_id);
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

  // One digest for open delist nags instead of N emails (saves email quota).
  if (nags.length && !quotaHit && emailsSent < MAX_EMAILS_PER_RUN) {
    const lines = nags.slice(0, 40).map((a) => {
      const t = shortTitle(titleOf(a), 40);
      return `${a.sku}${t ? ` ${t}` : ""} – delist ${channelName(a.payload?.channel)}`;
    });
    const subject = `DELIST – ${nags.length} SKU${nags.length === 1 ? "" : "s"} still listed elsewhere`;
    const text = `These sold units still need pulling from other marketplaces:\n\n${lines.join("\n")}${
      nags.length > 40 ? `\n…and ${nags.length - 40} more` : ""
    }\n\nOpen Floor → Incidents / delist tasks.`;
    const owners = await recipientsFor(nags[0]);
    let digestOk = false;
    let digestErr = null;
    for (const person of owners) {
      if (!person.notify_email) continue;
      const email = await emailFor(person, nags[0].store_id);
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
    detail: { schedule, stale, emailsSent, quotaHit, resendQuotaHit, gmail: gmailConfigured(), results: results.slice(0, 40) },
  });

  return json(200, {
    processed: results.length,
    emailsSent,
    quotaHit,
    stale,
    schedule,
    results,
    hint: quotaHit
      ? "Gmail SMTP daily sending limit hit — wait for it to reset. Critical sale alerts are deferred, not dropped."
      : resendQuotaHit
        ? "Resend daily quota hit — buyer shipped emails are deferred, not dropped."
        : !gmailConfigured()
          ? "Set GMAIL_SMTP_USER and GMAIL_SMTP_APP_PASSWORD in Netlify; internal alerts stay queued until then."
          : null,
  });
}

export const invoke = wrapHandler("dispatch-alerts", handle);

export default asNetlifyFunction(invoke);
