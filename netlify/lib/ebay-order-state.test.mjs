import test from 'node:test';
import assert from 'node:assert/strict';
import { ebayOrderState, readEbayOrderPages } from './ebay-order-state.mjs';

test('full refund or completed cancellation reverses sale; only unshipped stock is restored', () => {
  assert.equal(ebayOrderState({ orderPaymentStatus: 'FULLY_REFUNDED', orderFulfillmentStatus: 'NOT_STARTED' }).restock, true);
  assert.equal(ebayOrderState({ cancelStatus: { cancelState: 'CANCELED' }, orderFulfillmentStatus: 'FULFILLED' }).restock, false);
  assert.equal(ebayOrderState({ orderPaymentStatus: 'FULLY_REFUNDED' }).reversed, true);
});
test('pending cancellation, rejected cancellation and partial refunds retain a paid sale', () => {
  for (const cancelState of ['NONE_REQUESTED', 'CANCEL_REQUESTED', 'CANCEL_REJECTED']) {
    assert.equal(ebayOrderState({ orderPaymentStatus: 'PAID', cancelStatus: { cancelState } }).paid, true);
  }
  assert.equal(ebayOrderState({ orderPaymentStatus: 'PARTIALLY_REFUNDED' }).paid, true);
  assert.equal(ebayOrderState({ orderPaymentStatus: 'PENDING' }).paid, false);
});
test('canceled order after first page is included, with no external next host followed', async () => {
  const paths = [];
  const rows = await readEbayOrderPages(async path => {
    paths.push(path);
    return paths.length === 1 ? { orders: [{ orderId: 'paid' }], next: 'https://api.ebay.com/sell/fulfillment/v1/order?offset=50' }
      : { orders: [{ orderId: 'refunded', orderPaymentStatus: 'FULLY_REFUNDED' }] };
  }, '/sell/fulfillment/v1/order?offset=0');
  assert.equal(rows.length, 2);
  assert.equal(ebayOrderState(rows[1]).reversed, true);
  assert.deepEqual(paths, ['/sell/fulfillment/v1/order?offset=0', '/sell/fulfillment/v1/order?offset=50']);
});
