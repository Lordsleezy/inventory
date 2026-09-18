/** eBay authorization codes contain `#`. Browsers treat that as a fragment, so `state` never reaches the server. */

function looksLikeEbayCodePart(value) {
  const s = String(value || "");
  if (!s || s.includes("=")) return false;
  return /^(?:v\^|[riIpft]\^)/.test(s);
}

function applyHash(code, state, error, hash) {
  if (!hash) return { code, state, error };
  if (/^(?:code|state|error|error_description)=/.test(hash)) {
    const extra = new URLSearchParams(hash);
    if (extra.get("code")) code = extra.get("code");
    if (extra.get("state")) state = extra.get("state");
    error = extra.get("error_description") || extra.get("error") || error;
    return { code, state, error };
  }
  const amp = hash.indexOf("&");
  const before = amp >= 0 ? hash.slice(0, amp) : hash;
  const extra = amp >= 0 ? new URLSearchParams(hash.slice(amp + 1)) : new URLSearchParams();
  state = extra.get("state") || state;
  error = extra.get("error_description") || extra.get("error") || error;
  if (extra.get("code") && !looksLikeEbayCodePart(before)) {
    code = extra.get("code");
    return { code, state, error };
  }
  if (code && (amp >= 0 || looksLikeEbayCodePart(before))) {
    code = `${code}#${before}`;
  } else if (!code && looksLikeEbayCodePart(before)) {
    code = before.startsWith("v^") ? before : `v^1.1#${before}`;
  }
  return { code, state, error };
}

export function parseOAuthCallbackHref(href) {
  const empty = { code: "", state: "", error: "" };
  if (!href) return empty;
  let url;
  try {
    url = new URL(href);
  } catch {
    return empty;
  }
  const search = Object.fromEntries(url.searchParams.entries());
  let code = String(search.code || search.isAuthToken || search.ebaytkn || "");
  let state = String(search.state || "");
  let error = String(search.error_description || search.error || "");
  const hash = (url.hash || "").replace(/^#/, "");
  return applyHash(code, state, error, hash);
}

export function paramsFromNetlifyEvent(event) {
  const merged = {};
  const query = event.queryStringParameters || {};
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    merged[key] = Array.isArray(value) ? String(value[0]) : String(value);
  }
  const raw = event.rawQuery || event.rawQueryString;
  if (raw) {
    new URLSearchParams(String(raw)).forEach((value, key) => {
      if (value) merged[key] = value;
    });
  }
  if (event.rawUrl) {
    try {
      const parsed = parseOAuthCallbackHref(event.rawUrl);
      if (parsed.code) merged.code = parsed.code;
      if (parsed.state) merged.state = parsed.state;
      if (parsed.error) merged.error = parsed.error;
    } catch {
      /* ignore */
    }
  }
  let body = event.body || "";
  if (event.isBase64Encoded && body) body = Buffer.from(body, "base64").toString("utf8");
  if (body) {
    const contentType = String(event.headers?.["content-type"] || event.headers?.["Content-Type"] || "");
    if (contentType.includes("json")) {
      try {
        Object.assign(merged, JSON.parse(body));
      } catch {
        /* ignore */
      }
    } else {
      new URLSearchParams(body).forEach((value, key) => {
        if (value) merged[key] = value;
      });
    }
  }
  if (merged.href) {
    const parsed = parseOAuthCallbackHref(String(merged.href));
    if (parsed.code && parsed.code.length >= String(merged.code || "").length) merged.code = parsed.code;
    if (parsed.state) merged.state = parsed.state;
    if (parsed.error) merged.error = parsed.error;
  }
  return {
    code: String(merged.code || merged.isAuthToken || merged.ebaytkn || ""),
    state: String(merged.state || ""),
    error: String(merged.error_description || merged.error || ""),
    recovered: merged.recovered === "1" || merged.recovered === true,
  };
}
