/** Per-unit eBay exclusion stored in listing_specs so other channels are unaffected. */
export function ebayNeverList(unit) {
  if (unit?.ebay_never_list === true) return true;
  const specs = typeof unit?.listing_specs === 'string'
    ? JSON.parse(unit.listing_specs || '{}')
    : unit?.listing_specs || {};
  return specs.ebay_never_list === true || specs.marketplace_pricing?.channels?.ebay?.do_not_list === true;
}

export function assertEbayListable(unit) {
  if (ebayNeverList(unit)) throw new Error(`SKU ${unit?.sku || ''} is excluded from eBay listing.`);
}
