/** Website listing check (daily schedule, or "Run now" from Floor Admin → Online selling). */
import { serviceClient } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { runListingCheck } from "../lib/listing-check.mjs";

export const handler = async (event) => {
  const body = JSON.parse(event.body || "{}");
  let storeIds;
  try {
    const ctx = await portalAdminFromEvent(event, body.store_id || (body.all_stores ? "all" : null));
    storeIds = ctx.storeId === "all"
      ? ((await serviceClient().from("stores").select("id")).data || []).map(s => s.id)
      : [ctx.storeId];
  } catch {
    return { statusCode: 401 };
  }
  const sb = serviceClient();
  for (const id of storeIds) await runListingCheck(sb, id, { email: body.email !== false });
  return { statusCode: 202 };
};
