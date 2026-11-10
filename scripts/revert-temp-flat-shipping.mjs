/**
 * Put the temporary $1.99 listings back on the calculated policies they had.
 * One command: node scripts/revert-temp-flat-shipping.mjs
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
const { revertTempFlat } = await import("../netlify/lib/temp-flat-shipping.mjs");
const result = await revertTempFlat(serviceClient(), {
  storeId: STORE,
  force: true,
  reason: "manual revert",
});
console.log(JSON.stringify(result, null, 2));
if (result.ok === false) process.exit(1);
