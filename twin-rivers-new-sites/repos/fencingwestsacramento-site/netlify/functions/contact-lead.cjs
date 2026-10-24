const crypto = require("crypto");

const LEAD_ENDPOINT = "https://twinriversfence.com/";
const INGEST_ENDPOINT = "https://twinriversfence.com/.netlify/functions/lead-ingest";
const MIN_FILL_MS = 4000;
const MAX_FILL_MS = 24 * 60 * 60 * 1000;
const CITY_GATE_SECRET = "trf-city-gate-v4";
const ALLOWED_HOSTS = new Set([
  "fencingwestsacramento.com",
  "deckbuildingsacramento.com",
  "gateinstallationsacramento.com",
  "citrusheightsfencing.com",
  "fencessacramentoca.com",
  "twinriversfence.com",
  "rocklinfencing.com",
  "rosevillefencingca.com",
  "folsomfencing.com",
  "elkgrovefencing.com",
  "granitebayfencing.com",
  "grassvalleyfencing.com",
  "localhost",
]);

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

function parseBody(event) {
  const raw = event.body || "";
  const decoded = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  const contentType = String(event.headers["content-type"] || event.headers["Content-Type"] || "");
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(decoded || "{}");
    } catch (error) {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(decoded));
}

function wantsHtml(event) {
  const accept = String(event.headers.accept || event.headers.Accept || "");
  return accept.includes("text/html");
}

function clip(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function digits(value) {
  return clip(value, 40).replace(/\D/g, "");
}

function hostnameFromEnv() {
  try {
    if (process.env.URL) return new URL(process.env.URL).hostname.replace(/^www\./i, "");
  } catch (error) {}
  return "";
}

function siteOrigin() {
  for (const key of ["URL", "DEPLOY_PRIME_URL"]) {
    try {
      if (process.env[key]) return new URL(process.env[key]).origin;
    } catch (error) {}
  }
  return "";
}

function newLeadId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function formProof(startedAt) {
  const s = String(startedAt || "");
  let n = 2166136261;
  for (let i = 0; i < s.length; i++) {
    n ^= s.charCodeAt(i);
    n = Math.imul(n, 16777619);
  }
  return (n >>> 0).toString(16);
}

function cityGateToken(leadId) {
  return crypto.createHash("sha256").update(CITY_GATE_SECRET + "|" + String(leadId || "")).digest("hex").slice(0, 24);
}

function headerHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (error) {
    return "";
  }
}

function originAllowed(event) {
  const origin = headerValue(event, "origin") || headerValue(event, "referer");
  const host = headerHost(origin);
  return ALLOWED_HOSTS.has(host) || host.endsWith(".netlify.app");
}

function botUa(event) {
  const ua = headerValue(event, "user-agent").toLowerCase();
  return /python-requests|curl\/|scrapy|httpx|aiohttp|go-http-client|libwww-perl|php\/|java\/|wget|postman|insomnia|node-fetch|axios\/|okhttp|libcurl/.test(ua);
}

function phoneSane(phone) {
  const d = digits(phone);
  if (d.length < 10) return false;
  if (/^(\d)\1{9,}$/.test(d)) return false;
  const last10 = d.slice(-10);
  return !["1234567890", "0123456789", "9876543210", "5555555555", "1111111111"].includes(last10);
}

function powOk(data) {
  const started = clip(data.form_started_at, 80);
  const nonce = clip(data.form_pow, 20);
  if (!started || !/^\d+$/.test(nonce)) return false;
  if (Number(nonce) > 400000) return false;
  return formProof(started + ":" + nonce).slice(0, 3) === "000";
}

function timingReason(startedAt) {
  if (!clip(startedAt, 80)) return "missing";
  const started = Date.parse(String(startedAt));
  if (!Number.isFinite(started)) return "invalid";
  const elapsed = Date.now() - started;
  if (elapsed < 0 || elapsed > MAX_FILL_MS) return "invalid";
  if (elapsed < MIN_FILL_MS) return "too-fast";
  return "pass";
}

function headerValue(event, name) {
  const headers = event.headers || {};
  return String(headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "").trim();
}

function jsLeadOk(data, event) {
  const startedAt = data.form_started_at || "";
  const timing = timingReason(startedAt);
  const proofOk = clip(data.form_js, 40) === formProof(startedAt);
  const headerOk = headerValue(event, "x-fence-lead") === "1";
  const jsonOk = headerValue(event, "content-type").includes("application/json");
  const fetchOk = /^(same-origin|same-site)$/i.test(headerValue(event, "sec-fetch-site"));
  const cookieOk = /(?:^|;\s*)tr_js=1(?:;|$)/.test(headerValue(event, "cookie"));
  const intOk = Number(data.form_int) >= 2;
  const originOk = originAllowed(event);
  const uaOk = !botUa(event);
  const workOk = powOk(data);
  return {
    ok: timing === "pass" && proofOk && headerOk && jsonOk && fetchOk && cookieOk && intOk && originOk && uaOk && workOk,
    timing,
    proofOk,
    headerOk,
  };
}

function isQuoteLead(data) {
  const form = clip(data.form_name || data["form-name"], 80).toLowerCase();
  const type = clip(data.lead_type, 80).toLowerCase();
  return form === "instant-quote" || type === "fence-quote" || Boolean(data.estimated_range || data.footage);
}

function quoteDetails(data) {
  if (clip(data.quote_details, 4000)) return clip(data.quote_details, 4000);
  const parts = [];
  const fields = [
    ["fence_type", "Fence type"],
    ["height", "Height"],
    ["footage", "Linear feet"],
    ["gates", "Gates"],
    ["removal", "Removal"],
    ["estimated_range", "Estimated range"],
  ];
  for (const [key, label] of fields) {
    const value = clip(data[key], 120);
    if (value) parts.push(label + ": " + value);
  }
  return parts.join("\n");
}

function notificationMessage(record) {
  const chunks = [
    record.lead_type === "fence-quote" ? "CITY SITE FENCE QUOTE" : "CITY SITE LEAD",
    "Source: " + (record.source_domain || "unknown"),
    "Page: " + (record.source_page || "unknown"),
    "City: " + (record.city || "unknown"),
    "Name: " + (record.name || ""),
    "Phone: " + record.phone,
    "Email: " + (record.email || ""),
    "Lead ID: " + record.lead_id,
  ];
  if (record.quote_details) chunks.push("", record.quote_details);
  chunks.push("", record.message || "No project notes provided.");
  return chunks.join("\n");
}

async function timedFetch(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, ms);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function httpOk(response) {
  return Boolean(response) && response.status >= 200 && response.status < 400;
}

async function postIngest(record, extra) {
  try {
    const response = await timedFetch(
      INGEST_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Fence-City": cityGateToken(record.lead_id),
        },
        body: JSON.stringify(Object.assign({}, record, extra)),
      },
      8000
    );
    return { status: response.status, ok: response.ok };
  } catch (error) {
    return { status: 0, ok: false, network: true };
  }
}

async function deadLetter(record, ingestStatus) {
  const origin = siteOrigin();
  if (!origin) return false;
  const body = new URLSearchParams({
    "form-name": "lead-dead-letter",
    alert: "FAIL-OPEN Twin Rivers ingest unreachable",
    ingest_status: String(ingestStatus),
    lead_id: record.lead_id || "",
    name: record.name || "",
    phone: record.phone || "",
    email: record.email || "",
    city: record.city || "",
    source: record.source_domain || "",
    source_page: record.source_page || "",
    form_name: record.form_name || "",
    message: record.message || "",
  });
  const response = await timedFetch(
    origin + "/",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Fence-Lead": "1" },
      body: body.toString(),
      redirect: "manual",
    },
    8000
  );
  return httpOk(response);
}

async function failOpenWebhook(record, ingestStatus) {
  const webhook = clip(process.env.LEAD_FAIL_OPEN_WEBHOOK, 500);
  if (!webhook) return;
  await timedFetch(
    webhook,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alert: "fail-open",
        ingest_status: ingestStatus,
        lead_id: record.lead_id,
        source: record.source_domain,
        form_name: record.form_name,
      }),
    },
    5000
  );
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-Fence-Lead" } };
  }
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const data = parseBody(event);
  if (data["bot-field"] || clip(data.website, 200)) {
    return wantsHtml(event)
      ? { statusCode: 303, headers: { Location: "/success/" }, body: "" }
      : json(200, { ok: true, ignored: true });
  }

  const name = clip(data.name, 120);
  const phone = clip(data.phone, 40);
  if (!phoneSane(phone)) {
    return json(400, { ok: false, error: "A valid phone number is required." });
  }
  if (!isQuoteLead(data) && !name) {
    return json(400, { ok: false, error: "Name and phone are required." });
  }

  const jsLead = jsLeadOk(data, event);
  if (!jsLead.ok) {
    console.warn(
      "contact-lead blocked",
      "timing=" + jsLead.timing,
      "proof=" + jsLead.proofOk,
      "header=" + jsLead.headerOk
    );
    return json(400, { ok: false, error: "Verification failed." });
  }

  const quoteLead = isQuoteLead(data);
  const leadId = clip(data.lead_id, 80) || newLeadId();
  const city = clip(data.city, 80);
  const sourceDomain = hostnameFromEnv() || clip(data.source_domain || data.source, 200).replace(/^https?:\/\//i, "").split("/")[0];
  const record = {
    lead_id: leadId,
    submitted_at: new Date().toISOString(),
    name,
    email: clip(data.email, 200),
    phone,
    city,
    source_domain: sourceDomain,
    source_page: clip(data.source_page, 300),
    form_name: clip(data.form_name || data["form-name"], 80) || (quoteLead ? "instant-quote" : "contact"),
    lead_type: clip(data.lead_type, 80) || (quoteLead ? "fence-quote" : "contact"),
    message: clip(data.message || data.notes, 4000),
    project_details: clip(data.project_details, 4000),
    quote_details: quoteDetails(data),
    fence_type: clip(data.fence_type, 80),
    height: clip(data.height, 40),
    footage: clip(data.footage, 40),
    gates: clip(data.gates, 20),
    removal: clip(data.removal, 20),
    estimated_range: clip(data.estimated_range, 80),
    utm_source: clip(data.utm_source, 120),
    utm_medium: clip(data.utm_medium, 120),
    utm_campaign: clip(data.utm_campaign, 120),
    utm_term: clip(data.utm_term, 120),
    utm_content: clip(data.utm_content, 120),
    referrer: clip(data.referrer, 300),
  };

  const payload = new URLSearchParams({
    "form-name": "lead-chat",
    name,
    phone,
    email: record.email,
    city,
    source: sourceDomain,
    project_type: quoteLead ? "Fence quote calculator" : "City site contact form",
    notes: [city, sourceDomain, leadId].filter(Boolean).join(" / "),
    message: notificationMessage(record),
  });

  const ingest = await postIngest(record, {
    "cf-turnstile-response": data["cf-turnstile-response"] || data.cf_turnstile_response || "",
    form_started_at: data.form_started_at || "",
    "bot-field": data["bot-field"] || "",
  });

  if (ingest.status === 400) {
    return json(400, { ok: false, error: "Verification failed." });
  }

  if (!ingest.ok) {
    let saved = false;
    try {
      saved = await deadLetter(record, ingest.status);
    } catch (error) {
      saved = false;
    }
    try {
      await failOpenWebhook(record, ingest.status);
    } catch (error) {}
    if (!saved) {
      console.error("lead-dead-letter failed", "lead_id=" + leadId, "ingest_status=" + ingest.status);
      return json(502, { ok: false, error: "Lead destination was unreachable." });
    }
  } else {
    try {
      await timedFetch(
        LEAD_ENDPOINT,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Fence-Lead": "1" },
          body: payload.toString(),
        },
        8000
      );
    } catch (error) {
      console.error("lead-chat notify failed", "lead_id=" + leadId);
    }
  }

  if (wantsHtml(event)) {
    return { statusCode: 303, headers: { Location: "/success/" }, body: "" };
  }
  return json(200, { ok: true, lead_id: leadId });
};
