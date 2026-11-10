/**
 * Put listing package backups back on eBay.
 * Reads ebay_policy_backups rows whose kind is listing_package.
 * No listing packages were changed in the shipping review, so this finds nothing
 * unless a later run stored a backup.
 *
 * Usage: node scripts/rollback-listing-packages.mjs
 */
const SITE = "458b95f4-4adb-4721-97bc-400f8bb97597";
const NEED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE", "CONNECTIONS_KEY", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_ENV", "EBAY_DEV_ID", "EBAY_RU_NAME"];
if (!process.env.SUPABASE_SERVICE_ROLE && process.env.NETLIFY_AUTH_TOKEN) {
  const envRes = await fetch(`https://api.netlify.com/api/v1/sites/${SITE}/env`, {
    headers: { Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}` },
  });
  for (const row of await envRes.json()) {
    if (!NEED.includes(row.key)) continue;
    const value = row.values?.find((v) => v.context === "production")?.value || row.values?.[0]?.value;
    if (value) process.env[row.key] = value;
  }
}
const { serviceClient } = await import("../netlify/lib/server.mjs");
const { loadEbayAccount, userTokenForAccount } = await import("../netlify/lib/ebay-accounts.mjs");
const { ebayTradingCall } = await import("../netlify/lib/ebay-trading.mjs");
const sb = serviceClient();
const { data, error } = await sb.from("ebay_policy_backups").select("id, policy_id, body").eq("kind", "listing_package").order("created_at");
if (error) throw new Error(error.message);
if (!data?.length) {
  console.log("No listing package backups. Nothing to restore.");
  process.exit(0);
}
const account = await loadEbayAccount(data[0].body.store_id, { username: "ikonikdeals2026" });
const token = await userTokenForAccount(account);
for (const row of data) {
  const pkg = row.body?.ebay;
  if (!pkg || !row.policy_id) continue;
  const xml = `<ItemID>${row.policy_id}</ItemID><ShippingPackageDetails>
    <MeasurementUnit>English</MeasurementUnit>
    <PackageLength>${pkg.length}</PackageLength>
    <PackageWidth>${pkg.width}</PackageWidth>
    <PackageDepth>${pkg.height}</PackageDepth>
    <WeightMajor unit="lbs">${pkg.lb}</WeightMajor>
    <WeightMinor unit="oz">${pkg.oz}</WeightMinor>
  </ShippingPackageDetails>`;
  const result = String(await ebayTradingCall(token, "ReviseFixedPriceItem", xml, account));
  const ack = (result.match(/<Ack>([^<]*)<\/Ack>/) || [])[1];
  console.log(row.policy_id, ack || "no ack");
}
