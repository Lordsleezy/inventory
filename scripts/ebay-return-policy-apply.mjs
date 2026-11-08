/**
 * Create or update the 30-day buyer-pays return policy on each connected eBay
 * account and store that id. Does not revise listings, prices, or shipping.
 * Description updates are scripts/ebay-return-description-apply.mjs.
 */
import fs from "node:fs";
import path from "node:path";

for (const key of Object.keys(process.env)) {
  if (/^EBAY_/.test(key)) delete process.env[key];
}
const rows = JSON.parse(fs.readFileSync(path.join(process.env.TEMP || "", "netlify-env-inventoryobi.json"), "utf8"));
for (const row of rows) {
  if (!row?.key) continue;
  const values = Array.isArray(row.values) ? row.values : [];
  const picked = values.find((v) => v?.context === "production") || values[0];
  if (picked?.value != null && picked.value !== "") process.env[row.key] = String(picked.value);
}

const { applyBuyerPaysReturnPolicy } = await import("../netlify/lib/ebay-policies.mjs");
const { listEbayAccounts, loadEbayAccount } = await import("../netlify/lib/ebay-accounts.mjs");
const { serviceClient } = await import("../netlify/lib/server.mjs");

const STORE = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
const sb = serviceClient();
const accounts = [];
for (const row of (await listEbayAccounts(STORE)).filter((row) => row.status === "connected")) {
  accounts.push(await loadEbayAccount(STORE, { id: row.id }));
}
const summary = [];
for (const account of accounts) {
  try {
    const policy = await applyBuyerPaysReturnPolicy(account);
    await sb.from("ebay_accounts").update({
      return_policy_id: policy.returnPolicyId,
      updated_at: new Date().toISOString(),
    }).eq("id", account.id);
    summary.push({ username: account.username, role: account.role, returnPolicyId: policy.returnPolicyId, name: policy.name });
  } catch (err) {
    summary.push({ username: account.username, role: account.role, error: String(err.message || err).slice(0, 300) });
  }
}
console.log(JSON.stringify(summary, null, 2));
