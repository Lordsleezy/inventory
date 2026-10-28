/** Only completed cancellations/full refunds reverse a sale. Requests and partial refunds do not. */
export function ebayOrderState(order) {
  const cancel = String(order?.cancelStatus?.cancelState || '').toUpperCase();
  const payment = String(order?.orderPaymentStatus || '').toUpperCase();
  const reversed = ['CANCELED', 'CANCELLED'].includes(cancel) || payment === 'FULLY_REFUNDED';
  return {
    reversed,
    paid: !reversed && ['PAID', 'PARTIALLY_REFUNDED'].includes(payment),
    // A refund is not evidence that a shipped item came back to the store.
    restock: reversed && order?.orderFulfillmentStatus === 'NOT_STARTED',
    reason: `eBay ${payment || 'UNKNOWN'} / ${cancel || 'UNKNOWN'}`,
  };
}

/** Read all pages. Never follow a supplied host or issue a marketplace write. */
export async function readEbayOrderPages(read, firstPath) {
  const orders = [];
  const seen = new Set();
  let path = firstPath;
  while (path) {
    if (seen.has(path)) throw new Error('ebay_order_pagination_loop');
    seen.add(path);
    const page = await read(path);
    orders.push(...(page?.orders || []));
    if (!page?.next) break;
    const next = new URL(page.next, 'https://api.ebay.com');
    if (next.pathname !== '/sell/fulfillment/v1/order') throw new Error('invalid_ebay_order_page');
    path = next.pathname + next.search;
  }
  return orders;
}
