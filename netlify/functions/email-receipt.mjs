import { staffFromEvent, serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

async function sendResend({ to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from || !to) return { skipped: true, reason: !key || !from ? "missing_resend_env" : "missing_to" };
  const body = { from, to: [to], subject, text };
  if (html) body.html = html;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`resend ${res.status}: ${errBody}`);
  }
  return { ok: true };
}

function money(cents) {
  const n = Number(cents) || 0;
  return `$${(n / 100).toFixed(2)}`;
}

function defaultBranding(storeName) {
  return {
    storeName: storeName || "Floor",
    address: "3121 Penryn Rd, Penryn, CA 95663",
    phone: "(279) 977-0722",
    logoUrl: null,
    headerMessage: null,
    footerMessage: null,
    legal:
      "7-DAY EXCHANGE ONLY. No returns and no refunds. With this receipt, you may exchange the item or take store credit within 7 days of sale. Goods are sold AS-IS, WHERE-IS, with all faults, whether or not noted at sale. Floor is not the manufacturer and does not provide manufacturer warranty service unless a remaining OEM warranty still applies to that serial. Keep this receipt.",
    returnPolicy: null,
    reviewUrl: null,
    showSku: true,
    showCondition: true,
    showClerk: true,
    showDiscount: true,
    showPoints: true,
    showTax: true,
    showTenderDetails: true,
  };
}

function mergeBranding(stored, override, displayName) {
  const base = defaultBranding(displayName);
  const fromStore = stored && typeof stored === "object" ? stored : {};
  return { ...base, ...fromStore, ...(override || {}) };
}

function buildReceiptText(sales, branding, clerkName) {
  const first = sales[0];
  const receiptNo = first?.receipt_no || first?.ticket_id?.slice?.(0, 8) || "receipt";
  const soldAt = first?.sold_at ? new Date(first.sold_at).toLocaleString() : new Date().toLocaleString();
  const subtotal = sales.reduce((s, r) => s + (r.price_cents || 0), 0);
  const tax = sales.reduce((s, r) => s + (r.tax_cents || 0), 0);
  const total = subtotal + tax;
  const method = (first?.payment_method || "cash").toUpperCase();
  const cardBits = [first?.card_brand, first?.card_last4 ? `•••• ${first.card_last4}` : null].filter(Boolean).join(" ");
  const lines = [
    branding.storeName,
    branding.address,
    branding.phone,
    branding.headerMessage || "",
    "--------------------------------",
    `Date      ${soldAt}`,
    `Receipt   ${receiptNo}`,
    branding.showClerk !== false ? `Clerk     ${clerkName || first?.actor_name || ""}` : "",
    "--------------------------------",
  ];
  for (const s of sales) {
    if (branding.showSku !== false) lines.push(`SKU       ${s.sku}`);
    lines.push(s.title || "Item");
    if (branding.showCondition !== false && s.condition) lines.push(`Cond      ${s.condition}`);
    lines.push(`Price     ${money(s.price_cents)}`);
  }
  if (branding.showTax !== false) lines.push(`Tax       ${money(tax)}`);
  lines.push(`TOTAL     ${money(total)}`);
  lines.push(`Tender    ${method}${cardBits ? ` · ${cardBits}` : ""}`);
  lines.push("--------------------------------");
  lines.push(branding.legal || "");
  if (branding.returnPolicy) lines.push(branding.returnPolicy);
  if (branding.footerMessage) lines.push(branding.footerMessage);
  if (branding.reviewUrl) lines.push(`Review: ${branding.reviewUrl}`);
  return lines.filter((l) => l !== "").join("\n");
}

function buildReceiptHtml(sales, branding, clerkName) {
  const first = sales[0];
  const receiptNo = first?.receipt_no || "receipt";
  const soldAt = first?.sold_at ? new Date(first.sold_at).toLocaleString() : new Date().toLocaleString();
  const subtotal = sales.reduce((s, r) => s + (r.price_cents || 0), 0);
  const tax = sales.reduce((s, r) => s + (r.tax_cents || 0), 0);
  const total = subtotal + tax;
  const method = (first?.payment_method || "cash").toUpperCase();
  const cardBits = [first?.card_brand, first?.card_last4 ? `•••• ${first.card_last4}` : null].filter(Boolean).join(" ");
  const escape = (t) =>
    String(t || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const items = sales
    .map(
      (s) =>
        `<tr><td>${escape(s.title || "Item")}${
          branding.showSku !== false ? `<div style="color:#666;font-size:12px">${escape(s.sku)}</div>` : ""
        }</td><td style="text-align:right">${escape(money(s.price_cents))}</td></tr>`,
    )
    .join("");
  const logo = branding.logoUrl
    ? `<img src="${escape(branding.logoUrl)}" alt="" style="max-height:64px;margin-bottom:8px" />`
    : "";
  return `<!doctype html><html><body style="font:14px/1.5 system-ui,sans-serif;color:#111;max-width:480px;margin:0 auto;padding:24px">
${logo}
<h1 style="margin:0;font-size:22px">${escape(branding.storeName)}</h1>
<p style="color:#555;margin:4px 0 16px">${escape(branding.address || "")}<br/>${escape(branding.phone || "")}</p>
${branding.headerMessage ? `<p>${escape(branding.headerMessage)}</p>` : ""}
<p style="color:#666;font-size:12px">Receipt ${escape(receiptNo)} · ${escape(soldAt)}${
    branding.showClerk !== false ? ` · ${escape(clerkName || first?.actor_name || "")}` : ""
  }</p>
<table style="width:100%;border-collapse:collapse">${items}</table>
<div style="border-top:1px solid #ccc;margin-top:12px;padding-top:12px">
${branding.showTax !== false ? `<div style="display:flex;justify-content:space-between"><span>Tax</span><span>${escape(money(tax))}</span></div>` : ""}
<div style="display:flex;justify-content:space-between;font-weight:700;font-size:18px"><span>Total</span><span>${escape(money(total))}</span></div>
<div style="display:flex;justify-content:space-between"><span>Tender</span><span>${escape(`${method}${cardBits ? ` · ${cardBits}` : ""}`)}</span></div>
</div>
<p style="color:#555;font-size:12px;margin-top:20px">${escape(branding.legal || "")}</p>
${branding.footerMessage ? `<p style="color:#555">${escape(branding.footerMessage)}</p>` : ""}
${branding.reviewUrl ? `<p><a href="${escape(branding.reviewUrl)}">Leave a review</a></p>` : ""}
</body></html>`;
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  let ctx;
  try {
    ctx = await staffFromEvent(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json(msg === "not_staff" ? 403 : 401, { error: msg });
  }

  const body = JSON.parse(event.body || "{}");
  const ticketId = body.ticketId;
  const toEmail = String(body.toEmail || body.email || "").trim();
  if (!ticketId) return json(400, { error: "ticketId_required" });
  if (!toEmail || !toEmail.includes("@")) return json(400, { error: "toEmail_required" });

  const sb = serviceClient();
  const storeId = ctx.staff.store_id;

  const { data: sales, error: salesErr } = await sb
    .from("sales")
    .select(
      "id, sku, receipt_no, ticket_id, sold_at, price_cents, tax_cents, list_price_cents, payment_method, card_brand, card_last4, actor_id, voided_at",
    )
    .eq("store_id", storeId)
    .eq("ticket_id", ticketId)
    .is("voided_at", null)
    .order("id", { ascending: true });

  if (salesErr) return json(500, { error: salesErr.message });
  if (!sales?.length) return json(404, { error: "ticket_not_found" });

  const skus = [...new Set(sales.map((s) => s.sku))];
  const actorIds = [...new Set(sales.map((s) => s.actor_id).filter(Boolean))];
  const [{ data: units }, { data: staffRows }] = await Promise.all([
    sb.from("units").select("sku, title, brand, model, condition").eq("store_id", storeId).in("sku", skus),
    actorIds.length
      ? sb.from("staff").select("user_id, display_name").eq("store_id", storeId).in("user_id", actorIds)
      : Promise.resolve({ data: [] }),
  ]);
  const unitBySku = Object.fromEntries((units ?? []).map((u) => [u.sku, u]));
  const staffById = Object.fromEntries((staffRows ?? []).map((s) => [s.user_id, s]));

  const enriched = sales.map((s) => {
    const u = unitBySku[s.sku];
    const title =
      [u?.brand, u?.model].filter(Boolean).join(" ") || u?.title || "Item";
    return {
      ...s,
      title,
      condition: u?.condition ?? null,
      actor_name: staffById[s.actor_id]?.display_name ?? null,
      total_cents: (s.price_cents || 0) + (s.tax_cents || 0),
    };
  });

  const { data: settingsRows } = await sb
    .from("store_settings")
    .select("key, value")
    .eq("store_id", storeId)
    .in("key", ["receipt_branding", "display_name"]);

  let brandingStored = null;
  let displayName = null;
  for (const row of settingsRows ?? []) {
    if (row.key === "receipt_branding") brandingStored = row.value;
    if (row.key === "display_name") {
      displayName = typeof row.value === "string" ? row.value : row.value;
      if (typeof displayName === "object" && displayName != null) displayName = String(displayName);
    }
  }

  const branding = mergeBranding(brandingStored, body.branding, displayName);
  const text = buildReceiptText(enriched, branding, ctx.staff.display_name);
  const html = buildReceiptHtml(enriched, branding, ctx.staff.display_name);
  const receiptNo = enriched[0]?.receipt_no || ticketId.slice(0, 8);

  const result = await sendResend({
    to: toEmail,
    subject: `Your receipt from ${branding.storeName} (${receiptNo})`,
    text,
    html,
  });

  if (result.skipped) {
    return json(503, { error: result.reason || "email_unavailable", detail: "RESEND_API_KEY / RESEND_FROM not configured" });
  }

  return json(200, { ok: true, to: toEmail, receiptNo });
}

export const handler = wrapHandler("email-receipt", async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json(500, { error: msg });
  }
});
