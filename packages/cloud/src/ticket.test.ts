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

describe("allocateLineTaxes after discount", () => {
  it("taxes discounted subtotal", () => {
    const { discounted } = applyTicketDiscount([10000], 1000);
    const taxes = allocateLineTaxes(discounted, 725);
    assert.equal(discounted[0], 9000);
    assert.equal(taxes[0], Math.round((9000 * 725) / 10_000));
  });
});
