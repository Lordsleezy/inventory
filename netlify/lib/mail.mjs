import nodemailer from "nodemailer";

/**
 * Internal (owner / staff) alert mail via Gmail SMTP.
 *
 * Env (set in Netlify, never in code):
 *   GMAIL_SMTP_USER          the Gmail / Workspace address that sends AND receives (also used by gmail-sales-poll)
 *   GMAIL_SMTP_APP_PASSWORD  a Google "app password" for that account (2-Step Verification required)
 *
 * Customer-facing mail stays on Resend (see sendResend in receipt.mjs).
 */

let cachedTransport = null;
let cachedKey = "";

export function gmailConfigured() {
  return Boolean(process.env.GMAIL_SMTP_USER && process.env.GMAIL_SMTP_APP_PASSWORD);
}

function transport() {
  const user = process.env.GMAIL_SMTP_USER;
  const pass = process.env.GMAIL_SMTP_APP_PASSWORD;
  const key = `${user}:${pass}`;
  if (!cachedTransport || cachedKey !== key) {
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
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to];
  if (!recipients.length) return { skipped: true, reason: "no_recipient" };
  const info = await transport().sendMail({
    from: user,
    to: recipients,
    subject,
    text,
  });
  return { ok: true, messageId: info?.messageId || null };
}
