import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { serviceClient } from "./server.mjs";

const traces = new AsyncLocalStorage();
const SECRET = /(authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|ciphertext|connections[_-]?key|api[_-]?key|cookie|set-cookie|^bearer$|^token$)/i;

export function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 8) return "[max-depth]";
  if (typeof value === "string") {
    if (/^bearer\s+/i.test(value)) return "[redacted]";
    return value.length > 8000 ? `${value.slice(0, 8000)}…` : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((row) => redact(row, depth + 1));
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET.test(key) ? "[redacted]" : redact(child, depth + 1);
  }
  return out;
}

function clipDetail(detail) {
  const redacted = redact(detail && typeof detail === "object" ? detail : { value: detail });
  const raw = JSON.stringify(redacted);
  if (raw.length <= 24000) return redacted;
  return { clipped: true, preview: raw.slice(0, 24000) };
}

export function currentTrace() {
  return traces.getStore() || null;
}

export function setTrace(fields) {
  const cur = traces.getStore();
  if (!cur) return;
  Object.assign(cur, fields);
}

export function runTrace(fields, fn) {
  const parent = traces.getStore() || {};
  const next = {
    traceId: parent.traceId || randomUUID(),
    source: parent.source || "floor",
    storeId: parent.storeId || null,
    sku: parent.sku || null,
    ...fields,
  };
  return traces.run(next, fn);
}

export async function floorLog({ level = "info", event, message = null, detail = {}, source, storeId, sku, traceId } = {}) {
  const cur = traces.getStore() || {};
  const row = {
    store_id: storeId || cur.storeId || null,
    sku: sku || cur.sku || null,
    trace_id: traceId || cur.traceId || randomUUID(),
    source: source || cur.source || "floor",
    level,
    event: String(event || "log"),
    message: message == null ? null : String(message).slice(0, 2000),
    detail: clipDetail(detail),
  };
  try {
    const sb = serviceClient();
    const { error } = await sb.from("floor_logs").insert(row);
    if (error) console.log("floor_log_write_failed", error.message);
  } catch (err) {
    console.log("floor_log_write_failed", err instanceof Error ? err.message : String(err));
  }
  return row.trace_id;
}

function parseJson(text) {
  if (text == null || text === "") return null;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  }
}

function requestSummary(event) {
  const headers = event?.headers || {};
  return {
    method: event?.httpMethod || null,
    path: event?.path || null,
    query: redact({
      ...event?.queryStringParameters,
      ...(event?.queryStringParameters?.code ? { code: "[redacted]" } : {}),
    }),
    body: redact(parseJson(event?.body)),
    contentType: headers["content-type"] || headers["Content-Type"] || null,
  };
}

export function wrapHandler(source, fn) {
  return async (event, context) => {
    if (event?.httpMethod === "OPTIONS") return fn(event, context);
    const traceId = randomUUID();
    const started = Date.now();
    return runTrace({ traceId, source }, async () => {
      await floorLog({
        event: "fn.start",
        message: source,
        detail: requestSummary(event),
      });
      try {
        const res = await fn(event, context);
        const rawBody = res?.body;
        const jsonBody = typeof rawBody === "string" && /^\s*[{[]/.test(rawBody) ? parseJson(rawBody) : null;
        await floorLog({
          level: (res?.statusCode || 0) >= 400 ? "error" : "info",
          event: "fn.end",
          message: `${source} ${res?.statusCode}`,
          detail: {
            status: res?.statusCode,
            ms: Date.now() - started,
            body: jsonBody != null ? redact(jsonBody) : { nonJson: true, bytes: String(rawBody || "").length },
          },
        });
        if (jsonBody && typeof jsonBody === "object" && !Array.isArray(jsonBody) && (res?.statusCode || 0) >= 400 && !jsonBody.traceId) {
          return { ...res, body: JSON.stringify({ ...jsonBody, traceId }) };
        }
        return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await floorLog({
          level: "error",
          event: "fn.crash",
          message,
          detail: {
            name: err?.name || null,
            code: err?.code || null,
            path: err?.path || null,
            status: err?.status || null,
            ebay: redact(err?.body || null),
            stack: String(err?.stack || "").slice(0, 4000),
          },
        });
        const authStatus =
          message === "not_signed_in" || message === "not_staff"
            ? 401
            : message === "not_owner" || message === "not_manager"
              ? 403
              : null;
        if (authStatus) {
          return {
            statusCode: authStatus,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: message, traceId }),
          };
        }
        throw err;
      }
    });
  };
}
