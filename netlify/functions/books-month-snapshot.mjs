import { serviceClient, json } from "../lib/server.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { runMoneySync } from "../lib/money-sync.mjs";

/** 08:05 UTC on the 1st ≈ 00:05 America/Los_Angeles — sync balances, then snapshot prior month close. */
async function handle(event) {
  if (!isNetlifyScheduleEvent(event)) return json(403, { error: "schedule_only" });
  const sb = serviceClient();
  const { data: stores, error: se } = await sb.from("stores").select("id");
  if (se) throw se;
  const log = [];
  for (const { id: storeId } of stores || []) {
    await sb.from("store_settings").upsert(
      { store_id: storeId, key: "money_sync_state", value: { at: "1970-01-01T00:00:00.000Z" } },
      { onConflict: "store_id,key" },
    );
    try {
      log.push({ storeId, money: await runMoneySync(sb, storeId) });
    } catch (e) {
      log.push({ storeId, money_error: String(e?.message || e) });
    }
  }
  const { error: cap } = await sb.rpc("books_capture_money_month_snapshots");
  if (cap) throw cap;
  return json(200, { ok: true, stores: (stores || []).length, log });
}

export const invoke = wrapHandler("books-month-snapshot", handle);
export default asNetlifyFunction(invoke);
