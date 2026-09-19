import { serviceClient } from "./server.mjs";
import { ebayHosts } from "./ebay-env.mjs";
import {
  aspectsNeedRefresh,
  fillAspects,
  normalizeTaxonomyAspects,
  unitSpecificAspect,
} from "./ebay-aspects.mjs";
import { parseListingSpecs } from "./listing-copy.mjs";
import {
  conditionsNeedRefresh,
  listingConditionPayload,
  mapFloorCondition,
  parseItemConditions,
} from "./ebay-conditions.mjs";

/** Floor categories we list. Ask before adding others. Leaf eBay US IDs from the June 2026 tree. */
export const FLOOR_EBAY_CATEGORIES = [
  {
    slug: "refrigerators",
    name: "Refrigerators",
    ebayCategoryId: "20713",
    aliases: ["refrigerator", "refrigerators", "fridge", "fridges", "french door", "side by side"],
    standalone: true,
    defaults: { Installation: "Freestanding" },
  },
  {
    slug: "freezers",
    name: "Freezers",
    ebayCategoryId: "71260",
    aliases: ["freezer", "freezers", "chest freezer", "upright freezer"],
    standalone: true,
    defaults: { Installation: "Freestanding" },
  },
  {
    slug: "washers",
    name: "Washers",
    ebayCategoryId: "71256",
    aliases: ["washer", "washers", "washing machine", "washing machines", "laundry washer"],
    standalone: true,
    defaults: { Installation: "Freestanding" },
  },
  {
    slug: "dryers",
    name: "Dryers",
    ebayCategoryId: "71254",
    aliases: ["dryer", "dryers", "clothes dryer"],
    standalone: true,
    defaults: { Installation: "Freestanding" },
  },
  {
    slug: "ranges",
    name: "Ranges / ovens",
    ebayCategoryId: "71250",
    aliases: ["range", "ranges", "oven", "ovens", "stove", "stoves", "cooktop", "wall oven"],
    standalone: true,
    defaults: { Installation: "Freestanding" },
  },
  {
    slug: "dishwashers",
    name: "Dishwashers",
    ebayCategoryId: "116023",
    aliases: ["dishwasher", "dishwashers"],
    standalone: true,
    defaults: { Installation: "Freestanding" },
  },
  {
    slug: "microwaves",
    name: "Microwaves",
    ebayCategoryId: "150140",
    aliases: ["microwave", "microwaves"],
    standalone: true,
    defaults: { Installation: "Freestanding" },
  },
  {
    slug: "laptops",
    name: "Laptops",
    ebayCategoryId: "177",
    aliases: ["laptop", "laptops", "notebook", "notebooks", "computer", "pc laptop"],
    standalone: false,
    defaults: {},
  },
  {
    slug: "tvs",
    name: "TVs",
    ebayCategoryId: "11071",
    aliases: ["tv", "tvs", "television", "televisions"],
    standalone: false,
    defaults: {},
  },
  {
    slug: "small_kitchen",
    name: "Small kitchen appliances",
    ebayCategoryId: "20685",
    aliases: ["small kitchen", "small appliance", "blender", "toaster", "air fryer", "coffee maker"],
    standalone: true,
    defaults: { Installation: "Freestanding" },
  },
  {
    slug: "tools",
    name: "Tools",
    ebayCategoryId: "632",
    aliases: ["tool", "tools", "power tools", "drill", "saw"],
    standalone: false,
    defaults: {},
  },
  {
    slug: "vacuums",
    name: "Vacuums",
    ebayCategoryId: "20614",
    aliases: ["vacuum", "vacuums", "vacuum cleaner", "shop vac"],
    standalone: true,
    defaults: { Installation: "Freestanding" },
  },
];

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function resolveFloorCategory(label) {
  const needle = norm(label);
  if (!needle) return null;
  for (const cat of FLOOR_EBAY_CATEGORIES) {
    if (norm(cat.slug) === needle || norm(cat.name) === needle) return cat;
    if (cat.aliases.some((alias) => needle === norm(alias) || needle.includes(norm(alias)) || norm(alias).includes(needle))) {
      return cat;
    }
  }
  return null;
}

export function listingMeasures(unit) {
  const specs = { ...(parseListingSpecs(unit.listing_specs ?? unit.listingSpecs) || {}) };
  const body = unit.listing_body ?? unit.listingBody;
  if (body) specs.listing_body = body;
  return specs;
}

function rowToDef(row) {
  return {
    name: row.aspect_name,
    required: Boolean(row.required),
    recommended: Boolean(row.recommended),
    allowed: Array.isArray(row.allowed_values) ? row.allowed_values : [],
    selectionOnly: Boolean(row.selection_only),
    catalog: Boolean(row.catalog_list),
    sortIndex: row.sort_index ?? 0,
  };
}

export async function loadStoredAspects(ebayCategoryId) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("ebay_category_aspects")
    .select("aspect_name, required, recommended, allowed_values, selection_only, catalog_list, sort_index")
    .eq("ebay_category_id", String(ebayCategoryId))
    .order("sort_index");
  if (error) throw new Error(error.message);
  return (data || []).map(rowToDef);
}

export async function saveStoredAspects(ebayCategoryId, defs) {
  const sb = serviceClient();
  const id = String(ebayCategoryId);
  await sb.from("ebay_category_aspects").delete().eq("ebay_category_id", id);
  const rows = (defs || []).map((def, i) => ({
    ebay_category_id: id,
    aspect_name: def.name,
    required: Boolean(def.required),
    recommended: Boolean(def.recommended),
    allowed_values: def.allowed || [],
    selection_only: Boolean(def.selectionOnly),
    catalog_list: Boolean(def.catalog),
    sort_index: def.sortIndex ?? i,
    updated_at: new Date().toISOString(),
  }));
  if (rows.length) {
    const { error } = await sb.from("ebay_category_aspects").insert(rows);
    if (error) throw new Error(error.message);
  }
  return defs;
}

export async function loadRememberedDefaults(storeId, slug) {
  const sb = serviceClient();
  const { data } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", "ebay_aspect_defaults")
    .maybeSingle();
  const all = data?.value && typeof data.value === "object" ? data.value : {};
  const remembered = all[slug] && typeof all[slug] === "object" ? all[slug] : {};
  return { all, remembered };
}

export async function rememberAspectDefault(storeId, slug, aspectName, value) {
  if (unitSpecificAspect(aspectName)) return;
  const { all } = await loadRememberedDefaults(storeId, slug);
  const next = {
    ...all,
    [slug]: { ...(all[slug] || {}), [aspectName]: value },
  };
  if (!value) delete next[slug][aspectName];
  const sb = serviceClient();
  const { error } = await sb.from("store_settings").upsert(
    { store_id: storeId, key: "ebay_aspect_defaults", value: next },
    { onConflict: "store_id,key" },
  );
  if (error) throw new Error(error.message);
}

async function applicationToken() {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error("eBay app credentials are missing.");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });
  const res = await fetch(`${api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || "ebay_app_token_failed");
  return { api, token: json.access_token };
}

export async function fetchLiveAspects(ebayCategoryId) {
  const market = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const { api, token } = await applicationToken();
  const treeRes = await fetch(
    `${api}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${market}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const tree = await treeRes.json();
  const treeId = tree?.categoryTreeId || "0";
  const res = await fetch(
    `${api}/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category?category_id=${encodeURIComponent(ebayCategoryId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();
  return normalizeTaxonomyAspects(json?.aspects || []);
}

export async function refreshCategoryAspects(ebayCategoryId) {
  const live = await fetchLiveAspects(ebayCategoryId);
  await saveStoredAspects(ebayCategoryId, live);
  return live;
}

export async function loadStoredConditions(ebayCategoryId) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("ebay_category_conditions")
    .select("condition_id, ebay_name, sort_index")
    .eq("ebay_category_id", String(ebayCategoryId))
    .order("sort_index");
  if (error) throw new Error(error.message);
  return (data || []).map((row) => ({
    conditionId: String(row.condition_id),
    name: String(row.ebay_name || ""),
  }));
}

export async function saveStoredConditions(ebayCategoryId, allowed) {
  const sb = serviceClient();
  const id = String(ebayCategoryId);
  await sb.from("ebay_category_conditions").delete().eq("ebay_category_id", id);
  const rows = (allowed || []).map((row, i) => ({
    ebay_category_id: id,
    condition_id: String(row.conditionId),
    ebay_name: String(row.name || ""),
    sort_index: i,
    updated_at: new Date().toISOString(),
  }));
  if (rows.length) {
    const { error } = await sb.from("ebay_category_conditions").insert(rows);
    if (error) throw new Error(error.message);
  }
  return allowed;
}

export async function fetchLiveConditions(ebayCategoryId) {
  const market = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const { api, token } = await applicationToken();
  const filter = `categoryIds:{${ebayCategoryId}}`;
  const res = await fetch(
    `${api}/sell/metadata/v1/marketplace/${market}/get_item_condition_policies?filter=${encodeURIComponent(filter)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.errors?.[0]?.message || json.error_description || "ebay_conditions_failed");
  const policy = (json.itemConditionPolicies || []).find((row) => String(row.categoryId) === String(ebayCategoryId));
  return parseItemConditions(policy);
}

export async function refreshCategoryConditions(ebayCategoryId) {
  const live = await fetchLiveConditions(ebayCategoryId);
  await saveStoredConditions(ebayCategoryId, live);
  return live;
}

export async function prepareUnitCondition({ unit, liveCheck = false }) {
  const floor = resolveFloorCategory(unit.category);
  if (!floor) {
    const err = new Error(
      unit.category
        ? `“${unit.category}” is not one of Floor’s eBay categories. Ask before adding others.`
        : "This unit needs a Floor category mapped to eBay (refrigerators, washers, TVs, …).",
    );
    err.code = "ebay_category_unmapped";
    throw err;
  }
  let stored = await loadStoredConditions(floor.ebayCategoryId);
  let refreshed = false;
  if (!stored.length) {
    stored = await refreshCategoryConditions(floor.ebayCategoryId);
    refreshed = true;
  }
  if (liveCheck) {
    const live = await fetchLiveConditions(floor.ebayCategoryId);
    if (conditionsNeedRefresh(stored, live)) {
      stored = await saveStoredConditions(floor.ebayCategoryId, live);
      refreshed = true;
    }
  }
  const mapped = mapFloorCondition(unit.condition, stored);
  if (!mapped) {
    const allowed = stored.map((row) => `${row.name} (${row.conditionId})`).join(", ") || "none";
    const err = new Error(
      `eBay category ${floor.name} has no honest match for Floor grade “${unit.condition || "(blank)"}”. Allowed: ${allowed}. The unit grade was not changed.`,
    );
    err.code = "ebay_condition_unmapped";
    err.allowed = stored;
    throw err;
  }
  return {
    floor,
    refreshed,
    allowed: stored,
    mapped,
    payload: listingConditionPayload(mapped),
  };
}

function visibleDefs(defs) {
  return (defs || []).filter((row) => row.required || row.recommended);
}

export async function prepareUnitAspects({ storeId, unit, liveCheck = false }) {
  const floor = resolveFloorCategory(unit.category);
  if (!floor) {
    const err = new Error(
      unit.category
        ? `“${unit.category}” is not one of Floor’s eBay categories. Ask before adding others.`
        : "This unit needs a Floor category mapped to eBay (refrigerators, washers, TVs, …).",
    );
    err.code = "ebay_category_unmapped";
    throw err;
  }
  let stored = await loadStoredAspects(floor.ebayCategoryId);
  let refreshed = false;
  if (!stored.length) {
    stored = await refreshCategoryAspects(floor.ebayCategoryId);
    refreshed = true;
  }
  if (liveCheck) {
    const live = await fetchLiveAspects(floor.ebayCategoryId);
    if (aspectsNeedRefresh(stored, live)) {
      stored = await saveStoredAspects(floor.ebayCategoryId, live);
      refreshed = true;
    }
  }
  const specs = listingMeasures(unit);
  const { remembered } = storeId ? await loadRememberedDefaults(storeId, floor.slug) : { remembered: {} };
  const filled = fillAspects(stored, unit, specs, {
    remembered,
    categoryDefaults: floor.defaults,
    standalone: floor.standalone,
  });
  const ui = visibleDefs(filled.filled);
  const missingRequired = ui.filter((row) => row.required && !row.value).map((row) => row.name);
  const missingRecommended = ui.filter((row) => row.recommended && !row.value).map((row) => row.name);
  return {
    floor,
    refreshed,
    ...filled,
    ui,
    missingRequired,
    missingRecommended,
    ready: missingRequired.length === 0,
  };
}

export function mergeAspectOverride(specs, name, value) {
  const next = { ...(specs || {}) };
  const aspects = { ...(next.ebay_aspects && typeof next.ebay_aspects === "object" ? next.ebay_aspects : {}) };
  if (value) aspects[name] = value;
  else delete aspects[name];
  if (Object.keys(aspects).length) next.ebay_aspects = aspects;
  else delete next.ebay_aspects;
  return next;
}
