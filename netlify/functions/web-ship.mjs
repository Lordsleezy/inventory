import { staffFromEvent, json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { deliverOrderEmails } from "../lib/web-order-email.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });

  const { staff } = await staffFromEvent(event);
  const body = JSON.parse(event.body || "{}");
  const id = String(body.id || "").trim();
  const tracking = String(body.tracking || "").trim();
  if (!id) return json(400, { error: "id_required" });
  if (!tracking) return json(400, { error: "tracking_required" });

  const sb = serviceClient();
  const { data: current, error: loadErr } = await sb
    .from("web_orders")
    .select("*")
    .eq("id", id)
    .eq("store_id", staff.store_id)
    .maybeSingle();
  if (loadErr) return json(400, { error: loadErr.message });
  if (!current || current.status !== "paid" || !current.boxed_at) {
    return json(400, { error: "not_shippable" });
  }

  const { data: order, error } = await sb
    .from("web_orders")
    .update({
      shipped_at: current.shipped_at || new Date().toISOString(),
      tracking_number: current.shipped_at ? current.tracking_number : tracking,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("store_id", staff.store_id)
    .select("*")
    .maybeSingle();
  if (error) return json(400, { error: error.message });
  if (!order) return json(400, { error: "not_shippable" });

  const deliveries = await deliverOrderEmails(sb, order.id).catch(() => []);
  const emailed = deliveries.some(r => r.kind === "tracking" && r.ok);

  return json(200, { ok: true, order, emailed });
}

export const handler = wrapHandler("web-ship", handle);
