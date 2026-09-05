import { normalizeList, recordId } from "../../packages/inventree/src/list.ts";
import { TOKEN_PATH } from "../../packages/inventree/src/token.ts";

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function baseUrl() {
  const url = process.env.INVENTREE_URL;
  if (!url) {
    throw new Error(
      "INVENTREE_URL is required (example on Zorin: http://127.0.0.1 ). Do not assume :8000 — that is the Windows Docker port.",
    );
  }
  return url.replace(/\/$/, "");
}

export function basicAuth() {
  const user = process.env.INVENTREE_ADMIN_USER ?? "admin";
  const pass = requiredEnv("INVENTREE_ADMIN_PASSWORD");
  return {
    username: user,
    password: pass,
    header: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
  };
}

let cachedToken = null;
let csrfToken = null;

function readCsrf(res) {
  const headers = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const raw = headers.length ? headers : [res.headers.get("set-cookie")].filter(Boolean);
  for (const header of raw) {
    const match = String(header).match(/csrftoken=([^;]+)/);
    if (match) csrfToken = decodeURIComponent(match[1]);
  }
}

export async function ensureToken() {
  if (cachedToken) return cachedToken;
  try {
    const body = await api("GET", TOKEN_PATH, undefined, { basic: true });
    if (typeof body?.token === "string" && body.token) {
      cachedToken = body.token;
      return cachedToken;
    }
    throw new Error(`Token path ${TOKEN_PATH} responded without a token field`);
  } catch (err) {
    if (err.status === 404) {
      throw new Error(
        `FAIL  ${TOKEN_PATH} returned 404. That path is hard-configured from the M1 live probe. Do not guess /api/user/token/.`,
      );
    }
    throw err;
  }
}

export function rows(data) {
  return normalizeList(data).items;
}

export function idOf(record) {
  return recordId(record);
}

export async function api(method, path, body, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    Referer: `${baseUrl()}/`,
  };
  if (opts.basic || path.includes("/token/")) {
    headers.Authorization = basicAuth().header;
  } else {
    headers.Authorization = `Token ${await ensureToken()}`;
  }
  if (csrfToken) {
    headers["X-CSRFToken"] = csrfToken;
    headers.Cookie = `csrftoken=${csrfToken}`;
  }
  headers.Origin = baseUrl();
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  readCsrf(res);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function listAll(path) {
  const items = [];
  let next = path.includes("?") ? `${path}&limit=200` : `${path}?limit=200`;
  while (next) {
    const resolved = next.startsWith("http") ? new URL(next).pathname + new URL(next).search : next;
    const page = normalizeList(await api("GET", resolved));
    items.push(...page.items);
    if (!page.next) break;
    const url = new URL(page.next);
    next = url.pathname + url.search;
  }
  return items;
}

export const emptyLros = {
  condition: null,
  testStatus: "untested",
  defectNotes: null,
  mfrSerial: null,
  msrpCents: null,
  retail: { cents: null, retailer: null, capturedOn: null },
  askCents: null,
  floorCents: null,
  listings: ["ebay", "facebook", "tiktok", "amazon"].map((channel) => ({
    channel,
    state: "NOT_LISTED",
    url: null,
    listedOn: null,
  })),
  sale: null,
};
