/**
 * Amazon merchant-fulfilled (MFN) returns via Reports API:
 * GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE
 *
 * Requires Inventory and Order Tracking (and often Direct to Consumer Shipping).
 * Does not pull buyer PII beyond what the returns report already contains for RMA handling.
 */
import { spapiFetch, STORE_DEFAULT, marketplaceId } from "./amazon.mjs";
import { ingestReturnRow, parseAmazonReturnsTsv } from "./returns.mjs";
import { serviceClient } from "./server.mjs";

const REPORT_TYPE = "GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE";

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function createReturnsReport(storeId, startIso, endIso) {
  return spapiFetch(storeId, "POST", "/reports/2021-06-30/reports", {
    reportType: REPORT_TYPE,
    marketplaceIds: [marketplaceId()],
    dataStartTime: startIso,
    dataEndTime: endIso,
  });
}

async function getReport(storeId, reportId) {
  return spapiFetch(storeId, "GET", `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
}

async function getReportDocument(storeId, documentId) {
  return spapiFetch(
    storeId,
    "GET",
    `/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`,
  );
}

async function downloadDocument(doc) {
  const res = await fetch(doc.url);
  if (!res.ok) throw new Error(`amazon_report_download_${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (doc.compressionAlgorithm === "GZIP") {
    const zlib = await import("node:zlib");
    buf = zlib.gunzipSync(buf);
  }
  return buf.toString("utf8");
}

async function waitForReport(storeId, reportId, { attempts = 12, delayMs = 5000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const report = await getReport(storeId, reportId);
    const status = report?.processingStatus || report?.payload?.processingStatus;
    if (status === "DONE") return report;
    if (status === "CANCELLED" || status === "FATAL") {
      const err = new Error(`amazon_returns_report_${String(status).toLowerCase()}`);
      err.report = report;
      throw err;
    }
    await sleep(delayMs);
  }
  throw new Error("amazon_returns_report_timeout");
}

/**
 * Pull MFN returns for the last `lookbackDays` (max 60) and upsert into returns.
 */
export async function syncAmazonReturns(storeId = STORE_DEFAULT, opts = {}) {
  const lookback = Math.min(60, Math.max(1, Number(opts.lookbackDays || process.env.AMAZON_RETURNS_LOOKBACK_DAYS || 14)));
  const end = new Date();
  const start = new Date(end.getTime() - lookback * 86400_000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  let created;
  try {
    created = await createReturnsReport(storeId, startIso, endIso);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Missing role / not approved — soft fail so cron does not page.
    if (/AccessDenied|Unauthorized|403|InvalidInput/i.test(msg)) {
      return { ok: false, skipped: true, reason: msg, reportType: REPORT_TYPE };
    }
    throw err;
  }

  const reportId = created?.reportId || created?.payload?.reportId;
  if (!reportId) return { ok: false, error: "no_report_id", created };

  let report;
  try {
    report = await waitForReport(storeId, reportId, {
      attempts: opts.attempts || 10,
      delayMs: opts.delayMs || 4000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // CANCELLED often means "no returns in range" for MFN report.
    if (/cancelled/i.test(msg)) {
      return { ok: true, reportId, rows: 0, ingested: 0, note: "no_mfn_returns_in_range" };
    }
    throw err;
  }

  const documentId = report.reportDocumentId || report.payload?.reportDocumentId;
  if (!documentId) return { ok: true, reportId, rows: 0, ingested: 0 };

  const doc = await getReportDocument(storeId, documentId);
  const text = await downloadDocument(doc);
  const rows = parseAmazonReturnsTsv(text);

  const results = [];
  for (const row of rows) {
    try {
      const data = await ingestReturnRow(storeId, row);
      results.push({ ok: true, id: data?.id, external_return_id: row.external_return_id });
    } catch (err) {
      results.push({
        ok: false,
        external_return_id: row.external_return_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sb = serviceClient();
  await sb
    .from("connections")
    .update({ updated_at: new Date().toISOString(), last_error: null })
    .eq("store_id", storeId)
    .eq("provider", "amazon")
    .then(() => {})
    .catch(() => {});

  return {
    ok: true,
    reportId,
    lookbackDays: lookback,
    rows: rows.length,
    ingested: results.filter((r) => r.ok).length,
    errors: results.filter((r) => !r.ok),
  };
}
