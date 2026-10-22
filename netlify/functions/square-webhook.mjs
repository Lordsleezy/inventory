/**
 * Inbound Square webhook for refunds and disputes.
 *
 * Register in the Square Developer dashboard:
 *   URL https://inventoryobi.netlify.app/.netlify/functions/square-webhook
 *   Events refund.created, refund.updated, dispute.created, dispute.state.updated
 * Then set both Netlify env vars (do not commit the key):
 *   SQUARE_WEBHOOK_SIGNATURE_KEY
 *   SQUARE_WEBHOOK_NOTIFICATION_URL  (the exact URL registered above)
 *
 * A completed refund voids the sale only when it covers the captured charge.
 * A partial refund or a dispute is recorded and emailed. Neither auto-voids.
 */
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { filterDeliverableEmails, gmailConfigured, sendInternalAlert } from "../lib/mail.mjs";
import { parseSquareNotification, squareSignatureHeader, verifySquareSignature } from "../lib/square-webhook.mjs";

function rawBody(event) {
  return event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
}

async function notifyEmails(sb) {
  const cfg = (await sb.from("store_settings").select("value").eq("key", "order_notify_emails").limit(1)).data?.[0]?.value
    || ["pgg124@gmail.com", "obitracking@gmail.com"];
  const to = filterDeliverableEmails(Array.isArray(cfg) ? cfg : []);
  return to.length ? to : filterDeliverableEmails(["pgg124@gmail.com", "obitracking@gmail.com"]);
}

function alertText(note, result) {
  const skus = Array.isArray(result?.skus) ? result.skus.filter(Boolean).join(", ") : "";
  const amount = note.amountCents == null ? "unknown" : `$${(note.amountCents / 100).toFixed(2)}`;
  const lines = [
    `Square ${note.kind} ${note.status || ""}`.trim(),
    `Payment ${note.paymentId || "(none)"}`,
    `Amount ${amount}`,
    result?.action ? `Action ${result.action}` : "",
    skus ? `SKU ${skus}` : "",
    note.reason ? `Reason ${note.reason}` : "",
    "Partial refunds and disputes stay on the ledger until someone voids the sale.",
  ];
  return lines.filter(Boolean).join("\n");
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  const key = String(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "").trim();
  const url = String(process.env.SQUARE_WEBHOOK_NOTIFICATION_URL || "").trim();
  if (!key || !url) return json(503, { error: "square_webhook_not_configured" });
  const raw = rawBody(event);
  if (raw.length > 65_536) return json(413, { error: "payload_too_large" });
  if (!verifySquareSignature(key, url, raw, squareSignatureHeader(event.headers))) {
    return json(403, { error: "invalid_signature" });
  }
  let payload;
  try { payload = JSON.parse(raw || "{}"); }
  catch { return json(400, { error: "invalid_json" }); }
  const note = parseSquareNotification(payload);
  if (!note) return json(200, { ok: true, ignored: true });

  const sb = serviceClient();
  const { data, error } = await sb.rpc("apply_square_webhook", {
    p_event_id: note.eventId,
    p_event_type: note.eventType,
    p_kind: note.kind,
    p_payment_id: note.paymentId || null,
    p_resource_id: note.resourceId || null,
    p_status: note.status || null,
    p_amount_cents: note.amountCents,
    p_merchant_id: note.merchantId || null,
  });
  if (error) {
    console.error("square_webhook_failed", error.code || "error");
    return json(500, { error: "square_webhook_failed" });
  }
  if (data?.alert && gmailConfigured()) {
    const to = await notifyEmails(sb);
    const subject = note.kind === "dispute"
      ? `Square dispute ${note.status || ""} on ${note.paymentId || "unknown payment"}`
      : `Square refund ${note.status || ""} on ${note.paymentId || "unknown payment"}`;
    await sendInternalAlert({ to, subject, text: alertText(note, data) }).catch(() => undefined);
  }
  return json(200, { ok: true, action: data?.action || "recorded", duplicate: Boolean(data?.duplicate) });
}

export const invoke = wrapHandler("square-webhook", async event => {
  try { return await handle(event); }
  catch (err) {
    console.error("square_webhook_exception", err instanceof Error ? err.name : "error");
    return json(500, { error: "square_webhook_failed" });
  }
});

export default asNetlifyFunction(invoke);
