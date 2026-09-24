import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { withdrawOpenEbayTasks } from "../lib/ebay.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

async function sendResend({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from || !to) return { skipped: true };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`resend ${res.status}: ${body}`);
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
  if (pull.length) {
    return `SKU ${sku} sold on ${channel}. Pull it from: ${pull.join(", ")}.`;
  }
  return `SKU ${sku} sold on ${channel}.`;
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  const secret = process.env.ALERT_WEBHOOK_SECRET;
  if (secret) {
    const got = event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"];
    if (got !== secret && event.queryStringParameters?.secret !== secret) {
      return json(401, { error: "bad_secret" });
    }
  }

  const sb = serviceClient();
  await withdrawOpenEbayTasks().catch(() => undefined);
  await sb.rpc("enqueue_delist_nags");
  const { data: alerts, error } = await sb.rpc("peek_alerts", { p_limit: 50 });
  if (error) return json(500, { error: error.message });

  const results = [];
  for (const alert of alerts ?? []) {
    try {
      const staff = await sb
        .from("staff")
        .select("user_id, display_name, notify_email, notify_push, delist_duty, role")
        .eq("store_id", alert.store_id);
      const users = staff.data ?? [];
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
      } else {
        text = `SKU ${alert.sku} still needs delisting on ${payload.channel}.`;
        subject = `Delist reminder: SKU ${alert.sku}`;
      }

      if (alert.kind === "web_shipped" && payload.buyer_email) {
        await sendResend({ to: payload.buyer_email, subject, text });
        await sb.rpc("mark_alert_sent", { p_id: alert.id, p_error: null });
        results.push({ id: alert.id, ok: true, buyer: true });
        continue;
      }

      const recipients = users.filter((u) => {
        if (alert.kind === "double_sell") return u.notify_email || u.notify_push;
        if (alert.kind === "sale_delist" || alert.kind === "delist_nag") {
          return u.delist_duty || u.role === "owner";
        }
        if (alert.kind === "web_order") return u.role !== "staff" && u.notify_email;
        return false;
      });

      for (const person of recipients) {
        if (person.notify_email) {
          const { data: user } = await sb.auth.admin.getUserById(person.user_id);
          const email = user?.user?.email;
          if (email) await sendResend({ to: email, subject, text });
        }
        if (person.notify_push) await sendApns();
      }

      await sb.rpc("mark_alert_sent", { p_id: alert.id, p_error: null });
      results.push({ id: alert.id, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sb.rpc("mark_alert_sent", { p_id: alert.id, p_error: message });
      results.push({ id: alert.id, error: message });
    }
  }

  return json(200, { processed: results.length, results });
}

export const handler = wrapHandler("dispatch-alerts", handle);
