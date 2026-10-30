import { MAIL_TO } from "./sites.mjs";
import { redact } from "./plan.mjs";

export async function sendReleaseMail({ subject, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const replyTo = process.env.RESEND_REPLY_TO || MAIL_TO;
  const body = redact(text);
  const safeSubject = redact(subject).slice(0, 180);
  if (!key || !from) {
    console.error("release mail skipped: RESEND_API_KEY or RESEND_FROM is not set");
    console.error(safeSubject);
    console.error(body);
    return { skipped: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [MAIL_TO],
      reply_to: replyTo,
      subject: safeSubject,
      text: body,
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`resend ${res.status}: ${redact(errBody).slice(0, 500)}`);
  }
  return { ok: true };
}
