/**
 * Undo only the combined-weight profile attached on this batch.
 * Puts each policy's discount id back, and writes the services and handling
 * that were on the policy when the backup was taken. Does not touch the
 * combined-weight rule.
 * One command: node scripts/rollback-discount-profile-batch.mjs
 */
const SITE = "458b95f4-4adb-4721-97bc-400f8bb97597";
const STORE = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
if (!process.env.SUPABASE_SERVICE_ROLE && process.env.NETLIFY_AUTH_TOKEN) {
  const envRes = await fetch(`https://api.netlify.com/api/v1/sites/${SITE}/env`, {
    headers: { Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}` },
  });
  for (const row of await envRes.json()) {
    const value = row.values?.find((v) => v.context === "production")?.value || row.values?.[0]?.value;
    if (value && !process.env[row.key]) process.env[row.key] = value;
  }
}
process.env.EBAY_ENV = "production";
const { serviceClient } = await import("../netlify/lib/server.mjs");
const { loadEbayAccount, userTokenForAccount } = await import("../netlify/lib/ebay-accounts.mjs");
const sb = serviceClient();
const { data, error } = await sb
  .from("ebay_policy_backups")
  .select("policy_id, body, created_at")
  .eq("store_id", STORE)
  .eq("kind", "discount_profile_batch")
  .order("created_at", { ascending: true });
if (error) throw new Error(error.message);
const originals = new Map();
for (const row of data || []) {
  if (!row.policy_id || originals.has(row.policy_id)) continue;
  if (row.body?.domestic == null || !row.body?.name || !row.body?.services?.length) continue;
  originals.set(row.policy_id, row.body);
}
if (!originals.size) {
  console.log(JSON.stringify({ restored: 0, reason: "no batch backups" }));
  process.exit(0);
}
const account = await loadEbayAccount(STORE, { username: "ikonikdeals2026" });
const token = await userTokenForAccount(account);

function tag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return match ? match[1].trim() : "";
}

async function bpm(operation, body) {
  const res = await fetch("https://svcs.ebay.com/services/selling/v1/SellerProfilesManagementService", {
    method: "POST",
    headers: {
      "X-EBAY-SOA-OPERATION-NAME": operation,
      "X-EBAY-SOA-SECURITY-TOKEN": token,
      "X-EBAY-SOA-REQUEST-DATA-FORMAT": "XML",
      "X-EBAY-SOA-RESPONSE-DATA-FORMAT": "XML",
      "X-EBAY-SOA-GLOBAL-ID": "EBAY-US",
      "Content-Type": "text/xml",
    },
    body,
  });
  return res.text();
}

let restored = 0;
for (const [policyId, body] of originals) {
  const services = body.services.map((row) => `<domesticShippingPolicyInfoService>
    <shippingService>${row.service}</shippingService>
    <sortOrderId>${row.sort}</sortOrderId>
    <freeShipping>${row.free}</freeShipping>
    <fastShipping>${row.fast || "false"}</fastShipping>
    <buyerResponsibleForShipping>false</buyerResponsibleForShipping>
    <buyerResponsibleForPickup>false</buyerResponsibleForPickup>
  </domesticShippingPolicyInfoService>`).join("");
  const xml = await bpm("setSellerProfile", `<?xml version="1.0" encoding="utf-8"?>
<setSellerProfileRequest xmlns="http://www.ebay.com/marketplace/selling/v1/services">
  <shippingPolicyProfile>
    <profileId>${policyId}</profileId>
    <profileName>${body.name}</profileName>
    <profileType>SHIPPING</profileType>
    <shippingPolicyInfo>
      <shippingPolicyName>${body.name}</shippingPolicyName>
      <domesticShippingType>Calculated</domesticShippingType>
      <dispatchTimeMax>${body.dispatch || 2}</dispatchTimeMax>
      <shippingProfileDiscountInfo>
        <domesticFlatCalcDiscountProfileId>${body.domestic}</domesticFlatCalcDiscountProfileId>
        <applyDomesticPromoShippingProfile>false</applyDomesticPromoShippingProfile>
      </shippingProfileDiscountInfo>
      ${services}
      <packagingHandlingCosts currencyId="USD">${body.handling || "0.0"}</packagingHandlingCosts>
      <shippingPolicyCurrency>USD</shippingPolicyCurrency>
      <GlobalShipping>false</GlobalShipping>
    </shippingPolicyInfo>
  </shippingPolicyProfile>
</setSellerProfileRequest>`);
  const ack = tag(xml, "ack");
  if (ack !== "Success") throw new Error(`${policyId} ${ack} ${tag(xml, "message")}`);
  restored += 1;
  console.log(JSON.stringify({ restored: policyId, name: body.name, discount: body.domestic }));
}
console.log(JSON.stringify({ restored }));
