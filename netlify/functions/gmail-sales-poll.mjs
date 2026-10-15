import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { wrapHandler, floorLog, asNetlifyFunction } from "../lib/floor-log.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { ingestMarketplaceMail, loadStoreChannels } from "../lib/marketplace-email-parse.mjs";

/**
 * Gmail inbox reader: every 2 minutes, read new Depop / Mercari mail from the same Gmail account that
 * sends internal alerts, and run it through the exact ingest path marketplace-email uses
 * (marketplace_ingest_sale / needs_review). Processed mail is marked read.
 *
 * Env (Netlify, never in code):
 *   GMAIL_SMTP_USER, GMAIL_SMTP_APP_PASSWORD   Gmail address + app password (IMAP must be enabled on the account)
 * Optional:
 *   GMAIL_POLL_SENDERS        comma list of sender domains (default "depop.com,mercari.com")
 *   GMAIL_POLL_LOOKBACK_DAYS  how far back to look (default 45)
 *   GMAIL_POLL_INCLUDE_SEEN   "1" = also look at already-read mail in the lookback window (dedupe by Message-ID)
 *   GMAIL_POLL_EXTRA_USER / GMAIL_POLL_EXTRA_APP_PASSWORD  optional second inbox (e.g. main Gmail)
 */

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

function authorized(event) {
  if (isNetlifyScheduleEvent(event)) return true;
  const secret = process.env.MARKETPLACE_EMAIL_SECRET;
  if (!secret) return false;
  const got = event.headers?.["x-marketplace-secret"] || event.headers?.["X-Marketplace-Secret"];
  return got === secret;
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

async function pollOneInbox(sb, { user, pass }, store, channels, domains, lookbackDays, includeSeen, started) {
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
    failed: 0,
    errors: [],
  };
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const query = {
        since: new Date(Date.now() - lookbackDays * 86400_000),
        or: domains.map((d) => ({ from: d })),
      };
      if (!includeSeen) query.seen = false;
      const uids = ((await client.search(query, { uid: true })) || []).sort((a, b) => a - b);
      summary.found = uids.length;

      for (const uid of uids.slice(0, MAX_PER_RUN)) {
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
          if (!fromAllowed(parsed.from?.address, domains)) {
            summary.skipped_sender++;
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

async function pollInbox(sb) {
  const accounts = pollAccounts();
  if (!accounts.length) return { skipped: "gmail_not_configured" };

  const started = Date.now();
  const domains = senderDomains();
  const lookbackDays = Math.max(1, Number(process.env.GMAIL_POLL_LOOKBACK_DAYS) || 45);
  const includeSeen = process.env.GMAIL_POLL_INCLUDE_SEEN === "1";
  const { store, channels } = await loadStoreChannels(sb);

  const perAccount = [];
  const totals = { found: 0, matched: 0, needs_review: 0, ignored: 0, duplicate: 0, skipped_sender: 0, failed: 0, errors: [] };
  for (const account of accounts) {
    if (Date.now() - started > DEADLINE_MS) break;
    const one = await pollOneInbox(sb, account, store, channels, domains, lookbackDays, includeSeen, started);
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
  if (!authorized(event)) return json(401, { error: "unauthorized" });
  try {
    const sb = serviceClient();
    const result = await withLock("gmail-sales-poll", 90, () => pollInbox(sb), sb);
    const active = result && (result.matched || result.needs_review || result.failed || result.ignored);
    if (active) {
      await floorLog({
        level: result.failed ? "warn" : "info",
        event: "gmail.sales_poll",
        message: `matched=${result.matched} review=${result.needs_review} ignored=${result.ignored} failed=${result.failed}`,
        detail: result,
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
