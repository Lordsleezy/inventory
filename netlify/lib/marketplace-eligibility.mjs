/**
 * Marketplace policy eligibility. Mirrors public.evaluate_marketplace_eligibility.
 * status: allow | block | review
 */

const CAMERA_WORDS = [
  "camera", "cameras", "dslr", "mirrorless", "camcorder", "gopro", "webcam",
  "point and shoot", "film camera", "instant camera",
];

const CHARGER_CABLE_WORDS = [
  "charger", "charging cable", "usb cable", "power cable", "power cord",
  "ac adapter", "power adapter", "wall adapter", "charging dock", "charging stand",
  "lightning cable", "usb-c cable", "usb c cable", "extension cord", "hdmi cable",
  "aux cable", "earbud tips", "tech accessory",
];

const POWER_WORDS = [
  "rechargeable", "battery powered", "battery-powered", "cordless", "electric",
  "electronic", "plug-in", "plug in", "mains", "110v", "120v", "240v", "watt",
  "powered", "motorized", "bluetooth", "wifi", "wi-fi", "smart home",
  "toothbrush", "sonicare", "vacuum", "blender", "toaster", "microwave",
  "coffee maker", "air fryer", "heater", "fan ", "humidifier", "dehumidifier",
  "speaker", "headphones", "earbuds", "tablet", "laptop", "monitor", "television",
  "tv ", "drone", "robot", "printer", "scanner", "router", "modem", "console",
  "gameboy", "playstation", "xbox", "nintendo", "switch console",
];

const POWER_CATEGORIES = [
  "appliances", "electronics", "electric toothbrushes", "power tools",
  "small appliances", "kitchen appliances", "audio", "computers", "gaming",
  "tvs", "vacuums", "lighting", "smart home",
];

function hasWord(text, phrase) {
  const esc = String(phrase || "")
    .trim()
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  if (!esc) return false;
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`, "i").test(text);
}

function unitText(unit) {
  return [unit?.title, unit?.brand, unit?.model, unit?.category, unit?.ebay_title, unit?.listing_body]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function inferRequiresPower(unit) {
  if (unit?.requires_power === true || unit?.is_electrical === true) return true;
  if (unit?.requires_power === false && unit?.is_electrical === false) return false;
  const text = unitText(unit);
  const category = String(unit?.category || "").trim().toLowerCase();
  if (POWER_CATEGORIES.some((c) => category === c || category.includes(c))) return true;
  for (const word of POWER_WORDS) {
    if (hasWord(text, word.trim())) return true;
  }
  for (const word of CHARGER_CABLE_WORDS) {
    if (hasWord(text, word)) return true;
  }
  return null;
}

export function inferIsCamera(unit) {
  if (unit?.is_camera === true) return true;
  if (unit?.is_camera === false) return false;
  const text = unitText(unit);
  const category = String(unit?.category || "").trim().toLowerCase();
  if (category.includes("camera")) return true;
  for (const word of CAMERA_WORDS) {
    if (hasWord(text, word)) return true;
  }
  return false;
}

export function inferChargerOrCable(unit) {
  const text = unitText(unit);
  for (const word of CHARGER_CABLE_WORDS) {
    if (hasWord(text, word)) return word;
  }
  return null;
}

/**
 * @param {object} unit
 * @param {object} rules - marketplace_policy_rules.rules jsonb
 * @param {{ strike?: boolean, override?: { decision: string, note?: string } | null }} extras
 * @returns {{ status: 'allow'|'block'|'review', reason: string, source: string }}
 */
export function evaluateMarketplaceEligibility(unit, rules = {}, extras = {}) {
  const channelLabel = String(extras.channelLabel || extras.channel || "Marketplace");

  if (extras.strike) {
    return {
      status: "block",
      reason: `${channelLabel}: permanently blocked — policy strike on this SKU`,
      source: "strike",
    };
  }

  if (extras.override?.decision === "block") {
    return {
      status: "block",
      reason: `${channelLabel}: blocked by override — ${extras.override.note || "manual block"}`,
      source: "override",
    };
  }
  if (extras.override?.decision === "allow") {
    return {
      status: "allow",
      reason: `${channelLabel}: allowed by override — ${extras.override.note || "manual allow"}`,
      source: "override",
    };
  }

  if (rules && rules.enabled === false) {
    return { status: "allow", reason: `${channelLabel}: rules disabled`, source: "rules" };
  }

  const r = rules && typeof rules === "object" ? rules : {};
  const text = unitText(unit);
  const category = String(unit?.category || "").trim().toLowerCase();
  const isCamera = inferIsCamera(unit);
  const charger = inferChargerOrCable(unit);
  const power = unit?.requires_power === true || unit?.is_electrical === true
    ? true
    : unit?.requires_power === false && unit?.is_electrical !== true
      ? false
      : inferRequiresPower(unit);

  for (const word of r.blocked_keywords || []) {
    if (hasWord(text, word)) {
      return {
        status: "block",
        reason: `${channelLabel}: blocked — keyword "${word}"`,
        source: "rules",
      };
    }
  }

  for (const cat of r.blocked_categories || []) {
    if (category && category === String(cat).trim().toLowerCase()) {
      return {
        status: "block",
        reason: `${channelLabel}: blocked — category ${unit.category}`,
        source: "rules",
      };
    }
  }

  if (r.block_chargers_cables && charger) {
    if (!(r.allow_cameras && isCamera && !charger)) {
      return {
        status: "block",
        reason: `${channelLabel}: blocked — chargers/cables/tech accessories (${charger})`,
        source: "rules",
      };
    }
  }

  if (r.block_requires_power) {
    if (power === true) {
      if (r.allow_cameras && isCamera && !charger) {
        // cameras are an explicit Depop exception
      } else {
        return {
          status: "block",
          reason: `${channelLabel}: blocked — rechargeable/powered electronics`,
          source: "rules",
        };
      }
    } else if (power === null && r.review_if_power_unknown !== false) {
      if (!(r.allow_cameras && isCamera)) {
        return {
          status: "review",
          reason: `${channelLabel}: needs review — power/electrical status unknown`,
          source: "rules",
        };
      }
    }
  }

  if (r.require_own_photos || r.block_stock_photos) {
    if (unit?.has_stock_photos === true) {
      return {
        status: "block",
        reason: `${channelLabel}: blocked — stock photos not allowed`,
        source: "rules",
      };
    }
  }

  if (r.block_ai_images && unit?.has_ai_images === true) {
    return {
      status: "block",
      reason: `${channelLabel}: blocked — AI-generated images not allowed`,
      source: "rules",
    };
  }

  if (r.block_manufacturer_photos && unit?.has_manufacturer_photos === true) {
    return {
      status: "block",
      reason: `${channelLabel}: blocked — manufacturer/retailer photos not allowed`,
      source: "rules",
    };
  }

  for (const word of r.prohibited_keywords || []) {
    if (hasWord(text, word)) {
      return {
        status: "block",
        reason: `${channelLabel}: blocked — prohibited ("${word}")`,
        source: "rules",
      };
    }
  }

  if (Array.isArray(r.allowed_categories_only) && r.allowed_categories_only.length) {
    const allowed = r.allowed_categories_only.map((c) => String(c).trim().toLowerCase());
    if (!category || !allowed.includes(category)) {
      return {
        status: "block",
        reason: `${channelLabel}: blocked — category not in allow-list`,
        source: "rules",
      };
    }
  }

  return { status: "allow", reason: `${channelLabel}: eligible`, source: "rules" };
}

export function isOutboundAllowed(result) {
  return result?.status === "allow";
}

export const DEFAULT_CHANNEL_RULES = {
  depop: {
    enabled: true,
    block_requires_power: true,
    block_chargers_cables: true,
    allow_cameras: true,
    require_own_photos: true,
    block_stock_photos: true,
    block_ai_images: true,
    block_manufacturer_photos: true,
    review_if_power_unknown: true,
    blocked_keywords: [
      "charger", "charging cable", "power cord", "ac adapter", "usb cable",
      "extension cord", "hdmi cable", "rechargeable", "battery powered",
    ],
    blocked_categories: [
      "Appliances", "Electronics", "Electric Toothbrushes", "Power tools",
      "Small appliances", "Kitchen appliances", "TVs", "Vacuums", "Computers", "Gaming",
    ],
    notes: "Depop Electronics Policy: no mains/battery/solar powered items, chargers, cables, or tech accessories. Cameras and phone cases allowed. Own photos only.",
  },
  ebay: {
    enabled: true,
    block_requires_power: false,
    block_chargers_cables: false,
    allow_cameras: true,
    block_stock_photos: false,
    block_ai_images: true,
    block_manufacturer_photos: false,
    review_if_power_unknown: false,
    prohibited_keywords: [
      "alcohol", "beer", "wine", "liquor", "vodka", "whiskey", "hard seltzer", "seltzer",
      "tobacco", "cigarette", "vape", "firearm", "ammunition", "ammo",
    ],
    blocked_keywords: [],
    blocked_categories: [],
    notes: "eBay: block prohibited goods and AI images. Size/shipping gates stay in ebay-eligibility.",
  },
  whatnot: {
    enabled: true,
    block_requires_power: false,
    block_ai_images: true,
    block_stock_photos: false,
    review_if_power_unknown: false,
    prohibited_keywords: ["firearm", "ammunition", "ammo", "alcohol", "tobacco"],
    blocked_keywords: [],
    blocked_categories: [],
    notes: "Whatnot: block clearly prohibited goods and AI images.",
  },
  mercari: {
    enabled: true,
    block_requires_power: false,
    block_ai_images: true,
    block_stock_photos: true,
    review_if_power_unknown: false,
    prohibited_keywords: ["firearm", "ammunition", "ammo", "alcohol", "tobacco", "vape"],
    blocked_keywords: [],
    blocked_categories: [],
    notes: "Mercari: no stock/AI images; block prohibited goods.",
  },
  facebook: {
    enabled: true,
    block_requires_power: false,
    block_ai_images: true,
    block_stock_photos: true,
    block_manufacturer_photos: false,
    review_if_power_unknown: false,
    prohibited_keywords: ["firearm", "ammunition", "ammo", "alcohol", "tobacco"],
    notes: "Facebook/Instagram catalog: prefer own photos; no AI or stock.",
  },
  amazon: {
    enabled: true,
    block_requires_power: false,
    block_ai_images: true,
    block_stock_photos: false,
    review_if_power_unknown: false,
    prohibited_keywords: ["firearm", "ammunition", "ammo"],
    notes: "Amazon: gate AI images; keep recalled/ ungated categories as manual review when added.",
    review_keywords: ["recall", "recalled"],
  },
  website: {
    enabled: true,
    block_requires_power: false,
    block_ai_images: false,
    block_stock_photos: false,
    review_if_power_unknown: false,
    notes: "Own website — permissive; still honor strikes/overrides.",
  },
  tiktok: {
    enabled: true,
    block_requires_power: false,
    block_ai_images: true,
    block_stock_photos: true,
    review_if_power_unknown: false,
    prohibited_keywords: ["firearm", "ammunition", "ammo", "alcohol", "tobacco", "vape"],
    notes: "TikTok Shop: no stock/AI; block restricted goods.",
  },
  vendoo: {
    enabled: true,
    block_requires_power: false,
    block_ai_images: true,
    notes: "Vendoo is a crosslist hub. Export includes per-channel flags; items blocked on all Vendoo targets are excluded.",
  },
};

export const VENDOO_TARGET_CHANNELS = ["ebay", "whatnot", "depop", "mercari"];
