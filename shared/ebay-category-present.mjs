/**
 * Turn eBay Taxonomy suggestions into the short list Receive shows.
 * A suggestion is kept only when the leaf is the same product type as the title.
 * Substring accidents (the word "dry" inside "Drywall", "bag" inside "Bags") are dropped.
 */

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'new', 'used', 'set', 'each', 'item', 'product',
  'home', 'brand', 'size', 'pack', 'original', 'choice', 'pound', 'bag', 'count', 'pack',
  'ounce', 'ounces', 'inch', 'inches',
]);

function pieces(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
}

function stem(word) {
  if (word.length > 5 && word.endsWith('es') && !word.endsWith('ss')) return word.slice(0, -2);
  if (word.length >= 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function titleWords(title) {
  return pieces(title).filter((word) => !STOP.has(word)).map(stem);
}

function leafWords(name) {
  return pieces(name).map(stem);
}

function phrases(title) {
  const words = pieces(title);
  const out = [];
  for (let i = 0; i < words.length - 1; i += 1) {
    if (STOP.has(words[i]) && STOP.has(words[i + 1])) continue;
    out.push(`${words[i]} ${words[i + 1]}`);
  }
  return out;
}

function rowName(row) {
  return String(row?.categoryName || row?.category_name || '');
}

function rowPath(row) {
  return String(row?.categoryPath || row?.path || '');
}

function rowId(row) {
  return String(row?.categoryId || row?.category_id || '');
}

export function suggestionIsSane(title, row) {
  const name = rowName(row);
  if (!name || !rowId(row)) return false;
  const wanted = titleWords(title);
  const leaf = leafWords(name);
  const exact = leaf.filter((word) => wanted.includes(word));
  if (exact.some((word) => word.length >= 4) || exact.length >= 2) return true;
  const hay = `${name} ${rowPath(row)}`.toLowerCase();
  return phrases(title).some((phrase) => {
    const [a, b] = phrase.split(' ');
    return hay.includes(phrase) || hay.includes(`${stem(a)} ${stem(b)}`);
  });
}

export function presentCategorySuggestions(title, rows) {
  const seen = new Set();
  const kept = [];
  for (const row of rows || []) {
    const id = rowId(row);
    if (!id || seen.has(id) || !suggestionIsSane(title, row)) continue;
    seen.add(id);
    kept.push({
      category_id: id,
      category_name: rowName(row),
      path: rowPath(row),
      best_match: kept.length === 0,
    });
    if (kept.length === 4) break;
  }
  return kept;
}

/** Pre-select only when one leaf uniquely contains the title's product phrase. */
export function confidentCategory(title, rows) {
  const shown = presentCategorySuggestions(title, rows);
  const top = shown[0];
  if (!top) return null;
  const leaf = top.category_name.toLowerCase();
  const distinctive = phrases(title)
    .map((phrase) => {
      const [a, b] = phrase.split(' ');
      return [phrase, `${stem(a)} ${stem(b)}`];
    })
    .flat()
    .filter((phrase) => leaf.includes(phrase))
    .sort((a, b) => b.length - a.length);
  if (!distinctive.length) return null;
  const unique = distinctive.find((phrase) => shown.slice(1).every((row) => !row.category_name.toLowerCase().includes(phrase)));
  return unique ? top : null;
}

function aspectName(def) {
  return String(def?.name || '');
}

function aspectAllowed(def) {
  return Array.isArray(def?.allowed) ? def.allowed : [];
}

function aspectListOnly(def) {
  return Boolean(def?.selection_only || def?.selectionOnly) && aspectAllowed(def).length > 0;
}

/** Same check the listing step uses: required aspects, allowed values, and max length. */
export function missingAspectNames(fields, attributes) {
  const values = attributes || {};
  return (fields || []).filter((def) => {
    if (!def?.required) return false;
    const value = String(values[aspectName(def)] || '').trim();
    if (!value) return true;
    const max = Number(def.maxLength || def.max_length || 0);
    if (max > 0 && value.length > max) return true;
    if (def.multi && aspectListOnly(def)) {
      const parts = value.split('|').map((part) => part.trim()).filter(Boolean);
      if (!parts.length || parts.some((part) => !aspectAllowed(def).includes(part))) return true;
      return false;
    }
    if (aspectListOnly(def) && !aspectAllowed(def).includes(value)) return true;
    return false;
  }).map(aspectName);
}

export function ebayDetailsStatus({ categoryId, fields, attributes, conditionAllowed }) {
  if (!categoryId) return { ready: false, tone: 'bad', text: 'Needs a category' };
  const missing = missingAspectNames(fields, attributes);
  if (missing.length) return { ready: false, tone: 'bad', text: `${missing.length} required by eBay` };
  if (!conditionAllowed) return { ready: false, tone: 'bad', text: 'Condition' };
  return { ready: true, tone: 'muted', text: 'Ready for eBay' };
}

/**
 * The old Receive search. Kept so the regression can show why cat food
 * was offered as drywall: any 3-letter token is a substring, and Home & Garden
 * is ordered ahead of Pet Supplies no matter how many words actually match.
 */
export function legacyCategoryRank(paths, query) {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'new', 'used', 'set', 'each', 'item', 'product', 'home', 'brand', 'size']);
  const tokens = [...new Set(pieces(query))].filter((token) => !stop.has(token));
  const mainstream = /^(Home & Garden|Consumer Electronics|Electronics|Clothing, Shoes & Accessories|Business & Industrial|Health & Beauty|Sporting Goods|Books( & Magazines)?|Computers\/Tablets & Networking|Cell Phones & Accessories|Toys & Hobbies)( >|$)/i;
  return paths.map((path) => {
    const rankPath = String(path).replace(/^Root\s*>\s*/i, '');
    const score = tokens.filter((token) => rankPath.toLowerCase().includes(token)).length;
    return {
      path,
      score,
      mainstream: mainstream.test(rankPath) ? 0 : 1,
    };
  }).filter((row) => row.score > 0).sort((a, b) => a.mainstream - b.mainstream || b.score - a.score || a.path.localeCompare(b.path));
}
