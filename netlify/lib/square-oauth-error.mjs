import { redact } from "./floor-log.mjs";

// Never print the SDK error object: it contains the token request body.
export function squareOAuthFailure(err, url, secrets = []) {
  const scrub = (value) => {
    let text = JSON.stringify(redact(value));
    for (const secret of secrets.filter(Boolean)) {
      text = text.split(secret).join("[redacted]");
    }
    return JSON.parse(text.replace(/sq0(?:csp|cgp|atp|rtp)-[A-Za-z0-9_-]+/g, "[redacted]"));
  };
  let body = err?.body ?? err?.result ?? err?.message ?? "Unknown Square error";
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { /* retain non-JSON error */ }
  }
  body = scrub(body);
  const detail = typeof body === "string" ? body :
    (body.errors?.map((item) => [item.code, item.detail].filter(Boolean).join(": ")).join("; ") ||
      [body.error, body.error_description, body.message].filter(Boolean).join(": ") || JSON.stringify(body));
  const status = err?.statusCode || "network error";
  console.error("square_oauth_token_failed", { url, status, body });
  return new Error(`Square token exchange (${url}, HTTP ${status}): ${detail}`);
}
