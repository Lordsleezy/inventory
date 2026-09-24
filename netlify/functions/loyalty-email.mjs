/**
 * Loyalty email drain (welcome, points, campaigns) + optional staff drain trigger.
 * Scheduled every 5 minutes. Never SMS.
 */
import { serviceClient, json, corsHeaders, staffFromEvent } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { sendResend } from "../lib/receipt.mjs";

const STOREFRONT = (process.env.STOREFRONT_URL || "https://openboxindustries.com").replace(/\/$/, "");

function money(cents) {
  const n = Number(cents) || 0;
  return `$${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
}

function escape(t) {
  return String(t || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

function unsubUrl(token) {
  return `${STOREFRONT}/rewards/unsubscribe?token=${token || ""}`;
}

function footerText(token) {
  return `\n\nThis email is from Open Box Industries in Penryn. We do not text this number.\nUnsubscribe: ${unsubUrl(token)}`;
}

function render(row, storeName) {
  const name = row.name ? String(row.name).split(" ")[0] : "there";
  const unsub = row.unsub_token;
  const credit = money(row.credit_cents);
  const points = (Number(row.points) || 0) / 10;
  const pointsLabel = Number.isInteger(points) ? String(points) : points.toFixed(1);
  if (row.kind === "welcome") {
    const code = row.signup_code || "on your account";
    const subject = `Welcome to ${storeName} rewards — 5% off your first purchase`;
    const text = `Hi ${name},\n\nYou're in. Give us your phone at the register or checkout online and your 5% new-customer discount is applied once, automatically.\n\nYour code: ${code}\n(That's just a reminder — the phone number is what we look up. We never text it.)\n\nEvery $100 spent = 10 points. Every 100 points = $10 off at this store.\n${footerText(unsub)}`;
    const html = `<p>Hi ${escape(name)},</p><p>You're in. Give us your phone at the register or checkout on our website and your <strong>5% new-customer discount</strong> is applied once, automatically.</p><p>Your code: <strong>${escape(code)}</strong><br/>That's a reminder only — we look you up by phone. We never text that number.</p><p>Every $100 spent = 10 points. Every 100 points = $10 off at this store.</p><p style="color:#666;font-size:12px">We do not text you.<br/><a href="${escape(unsubUrl(unsub))}">Unsubscribe from store emails</a></p>`;
    return { subject, text, html, headers: listUnsub(unsub) };
  }
  if (row.kind === "points") {
    const earned = (Number(row.payload?.earned) || 0) / 10;
    const earnedLabel = Number.isInteger(earned) ? String(earned) : earned.toFixed(1);
    const subject = `Your ${storeName} rewards balance: ${pointsLabel} pts (${credit})`;
    const text = `Hi ${name},\n\nYou just earned ${earnedLabel} point${earned === 1 ? "" : "s"} on a purchase.\nBalance: ${pointsLabel} points = ${credit} store credit.\nEvery $100 spent = 10 points. Every 100 points = $10 off.\nUse it in the store or at checkout on our website with the same phone number.\n${footerText(unsub)}`;
    const html = `<p>Hi ${escape(name)},</p><p>You just earned <strong>${earnedLabel}</strong> point${earned === 1 ? "" : "s"}.</p><p>Balance: <strong>${pointsLabel} points</strong> = <strong>${escape(credit)}</strong> store credit.</p><p>Every $100 spent = 10 points. Every 100 points = $10 off.</p><p>Same phone number in the store and on the website.</p><p style="color:#666;font-size:12px"><a href="${escape(unsubUrl(unsub))}">Unsubscribe from store emails</a></p>`;
    return { subject, text, html, headers: listUnsub(unsub) };
  }
  const subject = row.subject || storeName;
  const body = row.body_text || "";
  const text = `${body}${footerText(unsub)}`;
  const html = `<div>${escape(body).replace(/\n/g, "<br/>")}</div><p style="color:#666;font-size:12px;margin-top:24px">We email — we do not text.<br/><a href="${escape(unsubUrl(unsub))}">Unsubscribe</a></p>`;
  return { subject, text, html, headers: listUnsub(unsub) };
}

function listUnsub(token) {
  const url = unsubUrl(token);
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

async function storeName(sb, storeId) {
  if (!storeId) return "Open Box Industries";
  const { data } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "display_name").maybeSingle();
  const raw = data?.value;
  if (typeof raw === "string") return raw.replace(/^"|"$/g, "") || "Open Box Industries";
  return "Open Box Industries";
}

export async function drainLoyaltyEmail(limit = 40) {
  const sb = serviceClient();
  const { data, error } = await sb.rpc("claim_email_outbox", { p_limit: limit });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const name = await storeName(sb, row.store_id);
      const built = render(row, name);
      const result = await sendResend({
        to: row.to_email,
        subject: built.subject,
        text: built.text,
        html: built.html,
        headers: built.headers,
      });
      if (result.skipped) {
        await sb.rpc("finish_email_outbox", { p_id: row.id, p_ok: false, p_error: result.reason });
        failed += 1;
      } else {
        await sb.rpc("finish_email_outbox", { p_id: row.id, p_ok: true, p_error: null });
        sent += 1;
      }
    } catch (err) {
      await sb.rpc("finish_email_outbox", {
        p_id: row.id,
        p_ok: false,
        p_error: err instanceof Error ? err.message : String(err),
      });
      failed += 1;
    }
  }
  return { claimed: rows.length, sent, failed };
}

export const handler = wrapHandler("loyalty-email", async (event) => {
  const cors = corsHeaders();
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  try {
    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      if (body.action && body.action !== "drain") {
        return json(400, { error: "unknown_action" });
      }
      if (event.headers?.authorization || event.headers?.Authorization) {
        const ctx = await staffFromEvent(event);
        if (!["owner", "manager"].includes(ctx.staff.role)) {
          return json(403, { error: "not_admin" });
        }
      }
    }
    const result = await drainLoyaltyEmail();
    return json(200, { ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /not_signed_in|not_staff|not_admin/.test(msg) ? 401 : 500;
    return json(status, { error: msg });
  }
});
