/** eBay authorization codes contain `#`. Browsers treat that as a fragment, so `state` never reaches the server. */

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
  if (hash) {
    const amp = hash.indexOf("&");
    if (code && amp >= 0) {
      code = `${code}#${hash.slice(0, amp)}`;
      const extra = new URLSearchParams(hash.slice(amp + 1));
      state = extra.get("state") || state;
      error = extra.get("error_description") || extra.get("error") || error;
    } else {
      const extra = new URLSearchParams(hash);
      if (extra.get("code")) code = extra.get("code");
      if (extra.get("state")) state = extra.get("state");
      error = extra.get("error_description") || extra.get("error") || error;
    }
  }
  return { code, state, error };
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
      new URL(event.rawUrl).searchParams.forEach((value, key) => {
        if (value) merged[key] = value;
      });
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
  return {
    code: String(merged.code || merged.isAuthToken || merged.ebaytkn || ""),
    state: String(merged.state || ""),
    error: String(merged.error_description || merged.error || ""),
    recovered: merged.recovered === "1" || merged.recovered === true,
  };
}
