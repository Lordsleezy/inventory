/**
 * Netlify scheduled invocations POST a JSON body like `{ next_run: "…" }`.
 * They never send ALERT_WEBHOOK_SECRET / staff auth — treat that shape as trusted.
 */
export function isNetlifyScheduleEvent(event) {
  if (!event) return false;
  const headers = event.headers || {};
  const nf =
    headers["x-nf-event"] ||
    headers["X-Nf-Event"] ||
    headers["x-netlify-event"] ||
    headers["X-Netlify-Event"];
  if (String(nf || "").toLowerCase() === "schedule") return true;
  try {
    const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
    if (body && typeof body === "object" && body.next_run && !body.action && Object.keys(body).length <= 3) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Expected cadence for the Jobs health panel (minutes). Keep in sync with root netlify.toml. */
export const SCHEDULED_JOBS = [
  { source: "census-seasonality-sync", everyMin: 43200, cron: "0 8 1 * *", label: "Census e-commerce seasonality (monthly)" },
  { source: "dispatch-alerts", everyMin: 5, cron: "*/5 * * * *", label: "Sale / delist alert emails (Gmail SMTP)" },
  { source: "ebay-sync", everyMin: 3, cron: "*/3 * * * *", label: "eBay orders + withdraw" },
  { source: "amazon-sync", everyMin: 10, cron: "*/10 * * * *", label: "Amazon orders + qty" },
  { source: "google-sync", everyMin: 1, cron: "* * * * *", label: "Google Merchant sync" },
  { source: "google-reconcile", everyMin: 360, cron: "0 */6 * * *", label: "Google reconcile" },
  { source: "channel-fee-sync", everyMin: 15, cron: "*/15 * * * *", label: "eBay/Square fee reconcile" },
  { source: "loyalty-email", everyMin: 5, cron: "*/5 * * * *", label: "Loyalty emails" },
  { source: "web-order-email", everyMin: 5, cron: "*/5 * * * *", label: "Web order emails" },
  { source: "web-order-reconcile", everyMin: 5, cron: "*/5 * * * *", label: "Web order reconcile" },
  { source: "web-pickup-sweep", everyMin: 10, cron: "*/10 * * * *", label: "Pickup sweep" },
  { source: "auto-fill-sweep", everyMin: 10, cron: "*/10 * * * *", label: "Auto eBay category + description" },
  { source: "listing-check", everyMin: 1440, cron: "0 14 * * *", label: "Listing check (daily)" },
  { source: "category-sync", everyMin: 1440, cron: "0 10 * * *", label: "Channel category sync (daily rotation)" },
  { source: "marketplace-daily-report", everyMin: 1440, cron: "0 16 * * *", label: "Marketplace daily report" },
  { source: "marketplace-sale-watch", everyMin: 5, cron: "*/5 * * * *", label: "Sale email → Orders safety net" },
  { source: "enrich-models", everyMin: 2, cron: "*/2 * * * *", label: "Model enrich" },
];
