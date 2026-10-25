// Channel checkbox queue worker. Pure logic over a small db interface so it can be unit tested.
// OFF unless store setting channel_autopush.enabled; eBay also needs channel_autopush.ebay_enabled.

export const CHANNELS = ["ebay", "amazon", "tiktok"];
export const MAX_ATTEMPTS = 5;
const DEFAULT_PER_RUN = { ebay: 1, amazon: 1, tiktok: 1 };

export function normalizeSetting(value) {
  const v = value && typeof value === "object" ? value : {};
  const perRun = { ...DEFAULT_PER_RUN };
  for (const ch of CHANNELS) {
    const n = Number(v.per_run?.[ch]);
    if (Number.isInteger(n) && n >= 0 && n <= 10) perRun[ch] = n;
  }
  return { enabled: v.enabled === true, ebay_enabled: v.ebay_enabled === true, per_run: perRun };
}

export function backoffMinutes(attempts) {
  return Math.min(15 * 2 ** Math.max(0, attempts - 1), 720);
}

export function classifyFailure(channel, error) {
  const msg = String(error || "listing_failed");
  if (channel === "tiktok" && /identity|approv|not[\s_]*authori[sz]ed|seller[\s_]*(review|verification)|pending/i.test(msg)) {
    return { keepQueued: true, retryable: true, waitMinutes: 360, issue: "TikTok Shop approval pending" };
  }
  if (/never_list|not_on_amazon|unknown_sku|listing_not_ready|needs_confirm|missing|invalid|forbidden|policy/i.test(msg)) {
    return { keepQueued: false, retryable: false, issue: msg };
  }
  return { keepQueued: false, retryable: true, issue: msg };
}

function later(now, minutes) {
  return new Date(now.getTime() + minutes * 60000).toISOString();
}

export async function processRow(db, deps, row, now) {
  const { store_id: storeId, sku, channel } = row;
  const fail = (error) => {
    const attempts = row.attempts + 1;
    const c = classifyFailure(channel, error);
    if (c.keepQueued) {
      return { status: "queued", attempts, issue: c.issue, last_error: String(error), retryable: true, next_attempt_at: later(now, c.waitMinutes) };
    }
    if (c.retryable && attempts < MAX_ATTEMPTS) {
      return { status: "queued", attempts, issue: `Retrying: ${c.issue}`, last_error: String(error), retryable: true, next_attempt_at: later(now, backoffMinutes(attempts)) };
    }
    return { status: "failed", attempts, issue: c.issue, last_error: String(error), retryable: c.retryable };
  };
  try {
    const live = await db.live(storeId, sku, channel);
    if (row.action === "end") {
      if (!live) return { status: "done", issue: null, last_error: null };
      const listing = (await db.listingRow(storeId, sku, channel)) || {};
      const r = await deps.end(storeId, channel, { ...listing, sku });
      return r?.ok === false ? fail(r.error || "end_failed") : { status: "done", issue: null, last_error: null };
    }
    if (!(await db.selected(storeId, sku, channel))) return { status: "cancelled", issue: null };
    const never = await db.neverReason(storeId, sku, channel);
    if (never) return { status: "failed", attempts: row.attempts, issue: `Never list: ${never}`, retryable: false };
    if (live) return { status: "done", issue: null, last_error: null, listing_ref: "already_live" };
    const gaps = await db.gaps(storeId, sku);
    if (gaps.length) return { status: "queued", issue: `Missing: ${gaps.join(", ")}`, next_attempt_at: later(now, 60) };
    const r = await deps.publish(storeId, channel, sku);
    if (r?.ok && !r?.needs_confirm) return { status: "done", issue: null, last_error: null, listing_ref: r.url || null };
    return fail(r?.needs_confirm ? "needs_confirm: Amazon new product page must be confirmed by hand" : r?.error || r?.message || "publish_failed");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function runAutopush({ db, deps, now = new Date() }) {
  const settings = await db.settings();
  const results = [];
  for (const { store_id: storeId, value } of settings) {
    const s = normalizeSetting(value);
    if (!s.enabled) { results.push({ storeId, skipped: "disabled" }); continue; }
    for (const channel of CHANNELS) {
      if (channel === "ebay" && !s.ebay_enabled) { results.push({ storeId, channel, skipped: "ebay_not_enabled" }); continue; }
      try {
        const rows = await db.dueRows(storeId, channel, s.per_run[channel], now);
        for (const row of rows) {
          if (!(await db.claim(row.id))) continue;
          const patch = await processRow(db, deps, row, now);
          await db.update(row.id, patch);
          results.push({ storeId, channel, sku: row.sku, action: row.action, status: patch.status, issue: patch.issue || null });
        }
      } catch (e) {
        results.push({ storeId, channel, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { results };
}

export function supabaseQueueDb(sb) {
  const rpc = async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  };
  return {
    async settings() {
      const { data, error } = await sb.from("store_settings").select("store_id, value").eq("key", "channel_autopush");
      if (error) throw new Error(error.message);
      return data || [];
    },
    async dueRows(storeId, channel, limit, now) {
      if (!limit) return [];
      const { data, error } = await sb.from("listing_queue").select("*")
        .eq("store_id", storeId).eq("channel", channel).eq("status", "queued")
        .lte("next_attempt_at", now.toISOString()).order("created_at").limit(limit);
      if (error) throw new Error(error.message);
      return data || [];
    },
    async claim(id) {
      const { data, error } = await sb.from("listing_queue").update({ status: "working", updated_at: new Date().toISOString() })
        .eq("id", id).eq("status", "queued").select("id");
      if (error) throw new Error(error.message);
      return Boolean(data?.length);
    },
    async update(id, patch) {
      const { error } = await sb.from("listing_queue").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new Error(error.message);
    },
    async selected(storeId, sku, channel) {
      const { data, error } = await sb.from("unit_channel_selections").select("selected")
        .eq("store_id", storeId).eq("sku", sku).eq("channel", channel).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.selected === true;
    },
    neverReason: (storeId, sku, channel) => rpc("floor_unit_never_list_reason", { p_store: storeId, p_sku: sku, p_channel: channel }),
    live: (storeId, sku, channel) => rpc("floor_unit_live_on", { p_store: storeId, p_sku: sku, p_channel: channel }),
    gaps: async (storeId, sku) => (await rpc("floor_unit_mandatory_gaps", { p_store: storeId, p_sku: sku })) || [],
    async listingRow(storeId, sku, channel) {
      const { data } = await sb.from("listings").select("*")
        .eq("store_id", storeId).eq("sku", sku).eq("channel", channel).eq("status", "listed").limit(1).maybeSingle();
      return data;
    },
  };
}

export const SMALL_PRICE_CUTOFF_CENTS = 1500;

/** New queue listings: Floor price, +10% (to the cent) when the Floor price is under $15. Buyer pays shipping. */
export function floorListPriceCents(unit) {
  const cents = Math.round(Number(unit?.ask_cents));
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return cents < SMALL_PRICE_CUTOFF_CENTS ? Math.round((cents * 11) / 10) : cents;
}

/**
 * Create a new listing at floorListPriceCents. If the SKU already exists on the channel
 * (e.g. listed by hand or by Codex), report it as live and never touch it — no reprice, no edit.
 */
export async function queuePublish({ loadUnit, existingListing, publish }, storeId, channel, sku) {
  const unit = await loadUnit(storeId, sku);
  if (!unit) return { ok: false, error: "unknown_sku" };
  const priceCents = floorListPriceCents(unit);
  if (!priceCents) return { ok: false, error: "missing price: set the Floor price" };
  const existing = await existingListing(storeId, channel, sku);
  if (existing) return { ok: true, already_live: true, url: existing.url || "already_live" };
  return publish(storeId, { channel, sku, priceCents });
}
