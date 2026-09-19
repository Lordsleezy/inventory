/** Floor grades stay as Floor wrote them. eBay IDs are per category. */

export const FLOOR_CONDITION_GRADES = [
  "New",
  "Open box",
  "Excellent",
  "Very good",
  "Good",
  "Fair",
  "For parts",
];

const NEW_IDS = new Set(["1000"]);
const OPEN_BOX_IDS = new Set(["1500", "2750"]);
const REFURB_IDS = new Set(["2000", "2010", "2020", "2030", "2500"]);
const USED_IDS = new Set(["3000", "4000", "5000", "6000"]);
const PARTS_IDS = new Set(["7000"]);

export function normalizeConditionName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function parseItemConditions(policy) {
  return (policy?.itemConditions || [])
    .map((row) => ({
      conditionId: String(row.conditionId || "").trim(),
      name: String(row.conditionDescription || row.conditionHelpText || "").trim(),
    }))
    .filter((row) => row.conditionId && row.name);
}

function findAllowed(allowed, pred) {
  return (allowed || []).find(pred) || null;
}

function byId(allowed, ids) {
  return findAllowed(allowed, (row) => ids.has(String(row.conditionId)));
}

function byName(allowed, test) {
  return findAllowed(allowed, (row) => test(normalizeConditionName(row.name)));
}

/**
 * Map a Floor grade onto one allowed eBay condition for this category.
 * Never upgrades used/defective grades to New, Open box, or Refurbished.
 * Returns null when the category has no honest equivalent.
 */
export function mapFloorCondition(floorGrade, allowed) {
  const grade = normalizeConditionName(floorGrade);
  const list = allowed || [];
  if (!grade || !list.length) return null;

  if (grade === "new") {
    return (
      byName(list, (n) => n === "new") ||
      byId(list, NEW_IDS)
    );
  }

  if (grade.includes("open")) {
    return (
      byName(list, (n) => n.includes("open box")) ||
      byId(list, OPEN_BOX_IDS) ||
      byName(list, (n) => n === "like new" || n === "new other")
    );
  }

  if (grade.includes("part")) {
    return (
      byName(list, (n) => n.includes("for parts") || n.includes("not working")) ||
      byId(list, PARTS_IDS)
    );
  }

  const usedPool = list.filter((row) => {
    const id = String(row.conditionId);
    const n = normalizeConditionName(row.name);
    if (NEW_IDS.has(id) || OPEN_BOX_IDS.has(id) || REFURB_IDS.has(id) || PARTS_IDS.has(id)) return false;
    if (n === "new" || n.includes("open box") || n.includes("refurb") || n.includes("for parts")) return false;
    return USED_IDS.has(id) || n.includes("used") || n.includes("excellent") || n.includes("very good") || n === "good" || n.includes("acceptable") || n.includes("fair");
  });

  if (grade.includes("excellent") && !grade.includes("refurb")) {
    return (
      byName(usedPool, (n) => n.includes("excellent")) ||
      byId(usedPool, new Set(["3000"])) ||
      usedPool[0] ||
      null
    );
  }
  if (grade.includes("very good")) {
    return (
      byName(usedPool, (n) => n.includes("very good")) ||
      byId(usedPool, new Set(["4000", "3000"])) ||
      usedPool[0] ||
      null
    );
  }
  if (grade === "good") {
    return (
      byName(usedPool, (n) => n === "good" || n === "used good" || n === "used") ||
      byId(usedPool, new Set(["5000", "3000"])) ||
      usedPool[0] ||
      null
    );
  }
  if (grade.includes("fair") || grade.includes("poor") || grade.includes("acceptable")) {
    return (
      byName(usedPool, (n) => n.includes("acceptable") || n.includes("fair")) ||
      byId(usedPool, new Set(["6000", "3000"])) ||
      usedPool[0] ||
      null
    );
  }

  return null;
}

/**
 * Inventory API wants ConditionEnum, not a raw ID. The same ID (3000) is
 * USED on appliances and USED_EXCELLENT on graded categories — use eBay's
 * name for this category, never a global ID table.
 */
export function inventoryConditionEnum(mapped) {
  const n = normalizeConditionName(mapped?.name);
  if (!n) return "";
  if (n === "new") return "NEW";
  if (n.includes("open box") || n === "new other" || n.includes("without tag")) return "NEW_OTHER";
  if (n === "like new") return "LIKE_NEW";
  if (n.includes("new with defect")) return "NEW_WITH_DEFECTS";
  if (n.includes("certified refurb")) return "CERTIFIED_REFURBISHED";
  if (n.includes("excellent refurb")) return "EXCELLENT_REFURBISHED";
  if (n.includes("very good refurb")) return "VERY_GOOD_REFURBISHED";
  if (n.includes("good refurb")) return "GOOD_REFURBISHED";
  if (n.includes("seller refurb")) return "SELLER_REFURBISHED";
  if (n.includes("for parts") || n.includes("not working")) return "FOR_PARTS_OR_NOT_WORKING";
  if (n.includes("pre owned excellent")) return "PRE_OWNED_EXCELLENT";
  if (n.includes("pre owned fair")) return "PRE_OWNED_FAIR";
  if (n === "used") return "USED";
  if (n.includes("excellent")) return "USED_EXCELLENT";
  if (n.includes("very good")) return "USED_VERY_GOOD";
  if (n === "used good" || n === "good") return "USED_GOOD";
  if (n.includes("acceptable") || n.includes("fair")) return "USED_ACCEPTABLE";
  if (n.includes("used")) return "USED";
  return "";
}

export function listingConditionPayload(mapped) {
  const condition = inventoryConditionEnum(mapped);
  if (!condition) return null;
  return { condition };
}

export function gradeMapForCategory(allowed) {
  return FLOOR_CONDITION_GRADES.map((grade) => {
    const mapped = mapFloorCondition(grade, allowed);
    return {
      floor: grade,
      conditionId: mapped?.conditionId || null,
      ebayName: mapped?.name || null,
      unmapped: !mapped,
    };
  });
}

export function conditionsNeedRefresh(stored, live) {
  const key = (rows) =>
    (rows || [])
      .map((row) => `${row.conditionId}:${normalizeConditionName(row.name)}`)
      .sort()
      .join("\0");
  return key(stored) !== key(live);
}
