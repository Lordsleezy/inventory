import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocateLineTaxes, applyTicketDiscount } from "./ticket.ts";

describe("applyTicketDiscount", () => {
  it("prorates percent discount across lines", () => {
    const { discounted, discountCents } = applyTicketDiscount([1000, 3000], 1000);
    assert.equal(discountCents, 400);
    assert.equal(discounted.reduce((a, b) => a + b, 0), 3600);
  });

  it("zero discount leaves prices", () => {
    const { discounted, discountCents } = applyTicketDiscount([500, 500], 0);
    assert.equal(discountCents, 0);
    assert.deepEqual(discounted, [500, 500]);
  });
});

describe("allocateLineTaxes", () => {
  it("keeps the ticket total and stays within a cent of each line", () => {
    const prices = [1000, 1000, 1000, 1000, 1000, 800];
    const taxes = allocateLineTaxes(prices, 725);
    const ticket = Math.round((prices.reduce((a, b) => a + b, 0) * 725) / 10_000);
    assert.equal(taxes.reduce((a, b) => a + b, 0), ticket);
    prices.forEach((price, i) => {
      assert.ok(Math.abs(taxes[i] - Math.round((price * 725) / 10_000)) <= 1);
    });
  });
});

describe("allocateLineTaxes after discount", () => {
  it("taxes discounted subtotal", () => {
    const { discounted } = applyTicketDiscount([10000], 1000);
    const taxes = allocateLineTaxes(discounted, 725);
    assert.equal(discounted[0], 9000);
    assert.equal(taxes[0], Math.round((9000 * 725) / 10_000));
  });
});
