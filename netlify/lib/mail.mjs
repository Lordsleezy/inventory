/**
 * Internal (owner / staff) alert mail via Gmail SMTP.
 *
 * Env (set in Netlify, never in code):
 *   GMAIL_SMTP_USER          the Gmail / Workspace address that sends AND receives (also used by gmail-sales-poll)
 *   GMAIL_SMTP_APP_PASSWORD  a Google "app password" for that account (2-Step Verification required)
 *
 * Customer-facing mail stays on Resend (see sendResend in receipt.mjs).
 *
 * nodemailer is loaded lazily so unit tests that import alert helpers (via
 * tiktok-shop → mail) do not require the Netlify-only dependency at root.
 */

let cachedTransport = null;
let cachedKey = "";
let nodemailerPromise = null;

function loadNodemailer() {
  if (!nodemailerPromise) {
    nodemailerPromise = import("nodemailer").then((m) => m.default || m);
  }
  return nodemailerPromise;
}

/** Non-routable / synthetic login domains — never use as SMTP recipients. */
const BLOCKED_EMAIL_HOSTS = new Set(["localhost", "local", "invalid", "test", "example", "example.com", "example.org", "example.net"]);

/**
 * True only for real-looking deliverable addresses.
 * Blocks employee PIN logins like local@employees.floor.local and *.local hosts.
 */
export function isDeliverableEmail(addr) {
  const s = String(addr || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return false;
  const host = s.split("@").pop() || "";
  if (!host || host.endsWith(".local") || BLOCKED_EMAIL_HOSTS.has(host)) return false;
  if (host.endsWith(".test") || host.endsWith(".invalid") || host.endsWith(".localhost")) return false;
  if (host.includes("employees.floor.") || host.includes("staff.floor.")) return false;
  return true;
}

export function filterDeliverableEmails(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : [list]) {
    const s = String(raw || "").trim();
    if (!isDeliverableEmail(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function gmailConfigured() {
  return Boolean(process.env.GMAIL_SMTP_USER && process.env.GMAIL_SMTP_APP_PASSWORD);
}

async function transport() {
  const user = process.env.GMAIL_SMTP_USER;
  const pass = process.env.GMAIL_SMTP_APP_PASSWORD;
  const key = `${user}:${pass}`;
  if (!cachedTransport || cachedKey !== key) {
    const nodemailer = await loadNodemailer();
    cachedTransport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass },
    });
    cachedKey = key;
  }
  return cachedTransport;
}

/**
 * Send an internal alert. Returns `{ skipped: true }` when Gmail SMTP is not configured
 * or there is no recipient; throws on SMTP failure so callers can record the error.
 */
export async function sendInternalAlert({ to, subject, text }) {
  const user = process.env.GMAIL_SMTP_USER;
  if (!gmailConfigured() || !to) return { skipped: true, reason: "gmail_smtp_not_configured" };
  const recipients = filterDeliverableEmails(Array.isArray(to) ? to : [to]);
  if (!recipients.length) return { skipped: true, reason: "no_deliverable_recipient" };
  const tx = await transport();
  const info = await tx.sendMail({
    from: user,
    to: recipients,
    subject,
    text,
  });
  return { ok: true, messageId: info?.messageId || null };
}
