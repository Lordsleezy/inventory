import { serviceClient } from "../server.mjs";

/**
 * Amazon dropship channel stays LOCKED until every checklist item is green.
 * Paul applies for the SP-API restricted role for buyer shipping addresses himself.
 */
export async function getAmazonReadiness(storeId) {
  const sb = serviceClient();
  let { data: row } = await sb.from("dropship_amazon_readiness").select("*").eq("store_id", storeId).maybeSingle();
  if (!row) {
    const ins = await sb.from("dropship_amazon_readiness").insert({ store_id: storeId }).select("*").single();
    row = ins.data;
  }
  const { data: settings } = await sb.from("dropship_settings").select("settings").eq("store_id", storeId).maybeSingle();
  const rules = settings?.settings || {};

  const items = [
    {
      key: "restricted_role",
      label: "Amazon restricted role for buyer shipping-address data",
      status: row.restricted_role === "approved" ? "green" : row.restricted_role === "missing" ? "red" : "unknown",
      detail:
        row.restricted_role === "approved"
          ? "Approved"
          : "Unknown / ask Paul — request the Restricted Data Token (RDT) role for buyer shipping address via Amazon Seller Central → Apps and Services → Develop Apps → your SP-API app → Roles. Needed so the bot can place supplier orders.",
    },
    {
      key: "us_warehouse",
      label: "US-warehouse supplier confirmed",
      status: row.us_warehouse_ok ? "green" : "red",
      detail: row.us_warehouse_ok ? "OK" : "Confirm CJ (or other) US warehouse stock for every Amazon DS- item",
    },
    {
      key: "packing_slip",
      label: "Packing slip / invoice show Open Box Industries",
      status: row.packing_slip_verified || rules.cj_blind_shipping_verified ? "green" : "red",
      detail: "Must never show the supplier",
    },
    {
      key: "brand_gating",
      label: "Brand and gating check",
      status: row.brand_gating_ok ? "green" : "red",
      detail: "Reuse Floor listing readiness / GS1 / category rules — never list another company's store brand",
    },
    {
      key: "handling",
      label: "Handling time ≤ 2 business days",
      status: row.handling_ok ? "green" : "red",
      detail: "Supplier processing + buffer must fit Amazon MFN expectations",
    },
    {
      key: "fees",
      label: "Amazon fees in fee table",
      status: row.fees_configured || rules.channel_fees?.amazon?.pct != null ? "green" : "red",
      detail: rules.channel_fees?.amazon?.verify ? "Present but marked verify" : "Configure in Rules",
    },
  ];

  const allGreen = items.every((i) => i.status === "green");
  const unlocked = Boolean(row.unlocked && allGreen);

  return {
    items,
    allGreen,
    unlocked,
    channelSwitchEnabled: unlocked,
    missing: items.filter((i) => i.status !== "green").map((i) => i.label),
    howToUnlock: [
      "In Amazon Seller Central open Apps and Services → Develop Apps → your Floor SP-API app.",
      "Request the restricted role that grants buyer shipping address (Restricted Data Token / PII).",
      "When Amazon approves, set restricted_role=approved in Dropship → Settings → Amazon checklist.",
      "Verify US warehouse, packing slip branding, brand gating, ≤2-day handling, and fee table.",
      "Only then does the Amazon channel switch become clickable.",
    ],
  };
}

export async function updateAmazonReadiness(storeId, patch) {
  const sb = serviceClient();
  const allowed = [
    "restricted_role",
    "us_warehouse_ok",
    "packing_slip_verified",
    "brand_gating_ok",
    "handling_ok",
    "fees_configured",
    "unlocked",
    "notes",
  ];
  const next = { updated_at: new Date().toISOString() };
  for (const k of allowed) {
    if (patch[k] != null) next[k] = patch[k];
  }
  // Never unlock unless checklist would be green — compute after merge.
  const current = await getAmazonReadiness(storeId);
  if (next.unlocked && !current.allGreen && patch.force_unlock !== true) {
    next.unlocked = false;
  }
  const { data, error } = await sb
    .from("dropship_amazon_readiness")
    .upsert({ store_id: storeId, ...next }, { onConflict: "store_id" })
    .select("*")
    .single();
  if (error) throw error;
  return getAmazonReadiness(storeId);
}

/** Amazon sync ignores DS- until channel unlocked + enabled. */
export function amazonShouldIngestDropship(settings, readiness) {
  return Boolean(settings?.enabled && settings?.amazon_channel_on && readiness?.unlocked);
}
