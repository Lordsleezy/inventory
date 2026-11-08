export const EBAY_SELLING_USERNAME = "ikonikdeals2026";
export const EBAY_ORDERS_ONLY_USERNAME = "pgg124-5";

/** Listing and policy writes are allowed only on the Open Box selling account. */
export function assertEbaySellerWrite(account) {
  const username = String(account?.username || "").trim().toLowerCase();
  if (username === EBAY_SELLING_USERNAME && account?.role === "selling") return account;
  const who = username || "an unknown account";
  const personal = username === EBAY_ORDERS_ONLY_USERNAME;
  const err = new Error(
    personal
      ? "Refusing to change eBay listings or policies on pgg124-5. pgg124-5 is read-only and orders only. Open Box writes only to ikonikdeals2026."
      : `Refusing to change eBay listings or policies on ${who}. Open Box writes only to the selling account ikonikdeals2026.`,
  );
  err.code = "ebay_write_refused";
  throw err;
}
