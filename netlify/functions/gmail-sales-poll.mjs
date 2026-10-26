import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import { json, corsHeaders, serviceClient, connectionAdminFromEvent } from "../lib/server.mjs";
import { wrapHandler, floorLog, asNetlifyFunction } from "../lib/floor-log.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { ingestMarketplaceMail, loadStoreChannels, mailAuthenticatedForMarketplace } from "../lib/marketplace-email-parse.mjs";
import { normalizeMessageId, planPollUids } from "../lib/gmail-poll-plan.mjs";

/**
 * DISABLED (Depop/Mercari email import is off for good: sales are entered by hand on the Depop tab; see
 * supabase 20261101100000_depop_manual_sales.sql). The handler returns immediately and is no longer scheduled.
 *
 * Was: Gmail inbox reader: every 2 minutes, read new Depop / Mercari mail from the same Gmail account that
 * sends internal alerts, and run it through the exact ingest path marketplace-email uses
 * (marketplace_ingest_sale / needs_review). Processed mail is marked read.
 *
 * Env (Netlify, never in code):
 *   GMAIL_SMTP_USER, GMAIL_SMTP_APP_PASSWORD   Gmail address + app password (IMAP must be enabled on the account)
 * Optional:
 *   GMAIL_POLL_SENDERS        comma list of sender domains (default "depop.com,mercari.com")
 *   GMAIL_POLL_LOOKBACK_DAYS  how far back to look (default 45)
 *   GMAIL_POLL_INCLUDE_SEEN   "1" = also look at already-read mail in the lookback window (dedupe by Message-ID)
 * Manual rescan: POST { "include_seen": true } with owner/manager Bearer token or x-marketplace-secret.
 * Previously-ignored Message-IDs are re-evaluated after a parser fix.
 * Spoof protection: only messages with dkim=pass for depop.com/mercari.com (Auth/ARC results) are ingested.
 *   GMAIL_POLL_EXTRA_USER / GMAIL_POLL_EXTRA_APP_PASSWORD  optional second inbox (e.g. main Gmail)
 */

const EMAIL_IMPORT_DISABLED = true;
const MAX_PER_RUN = 15;
const MAX_BYTES = 4_300_000;
const DEADLINE_MS = 22_000;

function senderDomains() {
  const list = (process.env.GMAIL_POLL_SENDERS || "depop.com,mercari.com")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  return list.length ? list : ["depop.com", "mercari.com"];
}

function fromAllowed(address, domains) {
  const host = String(address || "").toLowerCase().split("@").pop() || "";
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Trust gate for inbox mail.
 * Content that merely *looks like* a Depop/Mercari sale is NOT enough — anyone could
 * email obitracking a forged notice. Accept only when Authentication-Results or
 * ARC-Authentication-Results records dkim=pass for depop.com / mercari.com.
 * That is what makes the pgg124 → obitracking Gmail filter path safe: Google keeps
 * the original DKIM/ARC result. Spoofed From without marketplace DKIM is rejected.
 */
function mailAllowed(_parsed, raw, domains) {
  return mailAuthenticatedForMarketplace(raw, domains);
}

async function authorized(event) {
  if (isNetlifyScheduleEvent(event)) return true;
  const secret = process.env.MARKETPLACE_EMAIL_SECRET;
  const got = event.headers?.["x-marketplace-secret"] || event.headers?.["X-Marketplace-Secret"];
  if (secret && got === secret) return true;
  // Owner/manager can trigger a manual rescan from the admin portal (Bearer token).
  try {
    await connectionAdminFromEvent(event, ["owner", "manager"]);
    return true;
  } catch {
    return false;
  }
}

function pollAccounts() {
  const accounts = [];
  const primaryUser = process.env.GMAIL_SMTP_USER;
  const primaryPass = process.env.GMAIL_SMTP_APP_PASSWORD;
  if (primaryUser && primaryPass) accounts.push({ user: primaryUser, pass: primaryPass });
  const extraUser = process.env.GMAIL_POLL_EXTRA_USER;
  const extraPass = process.env.GMAIL_POLL_EXTRA_APP_PASSWORD;
  if (extraUser && extraPass && !accounts.some((a) => a.user.toLowerCase() === extraUser.toLowerCase())) {
    accounts.push({ user: extraUser, pass: extraPass });
  }
  return accounts;
}

async function pollOneInbox(sb, { user, pass }, store, channels, domains, lookbackDays, includeSeen, started, rescan) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  client.on("error", () => undefined);

  const summary = {
    user,
    found: 0,
    matched: 0,
    needs_review: 0,
    ignored: 0,
    duplicate: 0,
    skipped_sender: 0,
    skipped_auth: 0,
    failed: 0,
    fresh: 0,
    errors: [],
  };
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // From-domain search plus subject fallbacks for filter/manual forwards that rewrite From.
      const query = {
        since: new Date(Date.now() - lookbackDays * 86400_000),
        or: [
          ...domains.map((d) => ({ from: d })),
          { subject: "sale confirmation" },
          { subject: "made a sale" },
          { subject: "You've made a sale" },
          { subject: "shipping label and sale" },
        ],
      };
      if (!includeSeen) query.seen = false;
      const uids = (await client.search(query, { uid: true })) || [];
      summary.found = uids.length;
      // Newest first, and only a bounded envelope peek. The full body fetch
      // below is reserved for Message-IDs we have not already stored.
      const newest = [...uids].sort((a, b) => b - a).slice(0, 80);
      const envelopes = [];
      if (newest.length) {
        for await (const msg of client.fetch(newest, { envelope: true, uid: true }, { uid: true })) {
          envelopes.push(msg);
        }
      }
      const stored = new Set();
      if (store?.id) {
        const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString();
        const { data, error } = await sb
          .from("marketplace_email_sales")
          .select("message_id")
          .eq("store_id", store.id)
          .gte("created_at", since);
        if (error) throw new Error(error.message);
        for (const row of data || []) {
          if (!row.message_id) continue;
          stored.add(row.message_id);
          stored.add(normalizeMessageId(row.message_id));
        }
      }
      const planned = planPollUids(
        envelopes.map((msg) => {
          const messageId = msg?.envelope?.messageId || "";
          return {
            uid: msg.uid,
            stored: stored.has(messageId) || stored.has(normalizeMessageId(messageId)),
          };
        }),
        { rescan, limit: MAX_PER_RUN },
      );
      summary.fresh = planned.length;

      for (const uid of planned) {
        if (Date.now() - started > DEADLINE_MS) break;
        try {
          const msg = await client.fetchOne(uid, { source: true, flags: true }, { uid: true });
          const raw = msg?.source;
          if (!raw) throw new Error("empty_source");
          const alreadySeen = msg.flags?.has("\\Seen");
          if (raw.length > MAX_BYTES) {
            summary.ignored++;
            if (!alreadySeen) await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
            continue;
          }
          const parsed = await new PostalMime().parse(raw);
          if (!mailAllowed(parsed, raw, domains)) {
            if (fromAllowed(parsed.from?.address, domains)) summary.skipped_auth++;
            else summary.skipped_sender++;
            // Mark seen so forgeries / newsletters do not starve the 15/run budget.
            if (!alreadySeen) await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
            continue;
          }
          const result = await ingestMarketplaceMail(sb, { store, channels, parsed, raw });
          summary[result.state] = (summary[result.state] || 0) + 1;
          if (!alreadySeen) await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        } catch (err) {
          summary.failed++;
          if (summary.errors.length < 5) summary.errors.push(`uid ${uid}: ${String(err?.message || err).slice(0, 160)}`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
  return summary;
}

async function pollInbox(sb, { forceIncludeSeen = false, rescan = false } = {}) {
  const accounts = pollAccounts();
  if (!accounts.length) return { skipped: "gmail_not_configured" };

  const started = Date.now();
  const domains = senderDomains();
  const lookbackDays = Math.max(1, Number(process.env.GMAIL_POLL_LOOKBACK_DAYS) || 45);
  const includeSeen = forceIncludeSeen || process.env.GMAIL_POLL_INCLUDE_SEEN === "1";
  const { store, channels } = await loadStoreChannels(sb);

  const perAccount = [];
  const totals = { found: 0, matched: 0, needs_review: 0, ignored: 0, duplicate: 0, skipped_sender: 0, skipped_auth: 0, failed: 0, fresh: 0, errors: [] };
  for (const account of accounts) {
    if (Date.now() - started > DEADLINE_MS) break;
    const one = await pollOneInbox(sb, account, store, channels, domains, lookbackDays, includeSeen, started, rescan);
    perAccount.push(one);
    for (const k of Object.keys(totals)) {
      if (k === "errors") totals.errors.push(...(one.errors || []).map((e) => `${one.user}: ${e}`));
      else totals[k] += one[k] || 0;
    }
  }
  return { ...totals, accounts: perAccount.map((a) => ({ user: a.user, found: a.found, matched: a.matched, needs_review: a.needs_review, failed: a.failed })) };
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (EMAIL_IMPORT_DISABLED) return json(200, { disabled: true, reason: "email_sale_import_disabled" });
  if (!(await authorized(event))) return json(401, { error: "unauthorized" });
  try {
    let forceIncludeSeen = false;
    if (event.httpMethod === "POST" && event.body) {
      try {
        const body = JSON.parse(event.body);
        forceIncludeSeen = body?.include_seen === true || body?.action === "rescan_inbox";
      } catch {
        /* ignore bad JSON — schedule events have no body */
      }
    }
    const sb = serviceClient();
    const result = await withLock(
      "gmail-sales-poll",
      90,
      () => pollInbox(sb, { forceIncludeSeen, rescan: forceIncludeSeen }),
      sb,
    );
    // Always leave a gmail.sales_poll breadcrumb (including found=0) so empty-inbox days are diagnosable.
    if (result && !result.skipped) {
      await floorLog({
        level: result.failed ? "warn" : "info",
        event: "gmail.sales_poll",
        message: `found=${result.found || 0} fresh=${result.fresh || 0} matched=${result.matched || 0} review=${result.needs_review || 0} ignored=${result.ignored || 0} failed=${result.failed || 0}${forceIncludeSeen ? " rescan=1" : ""}`,
        detail: { ...result, include_seen: forceIncludeSeen || process.env.GMAIL_POLL_INCLUDE_SEEN === "1" },
      });
    }
    return json(200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: message.slice(0, 300) });
  }
}

export const invoke = wrapHandler("gmail-sales-poll", handle);

export default asNetlifyFunction(invoke);
