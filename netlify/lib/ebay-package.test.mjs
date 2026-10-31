import assert from "node:assert/strict";
import test from "node:test";
import { packageGirth, shippablePackage } from "./ebay-package.mjs";

test("a flat runner is rolled into a long thin box that fits USPS Priority", () => {
  const packed = shippablePackage({
    title: "Kensington multipurpose runner rug 24x60",
    package_length_in: 60,
    package_width_in: 24,
    package_height_in: 2,
    package_weight_lb: 5,
  });
  assert.equal(packed.ok, true);
  assert.equal(packed.estimated, true);
  assert.ok(packageGirth(packed.length, packed.width, packed.height) <= 108);
  assert.equal(packed.service, "USPSPriority");
});

test("missing package specs are estimated and marked", () => {
  const packed = shippablePackage({ title: "Throw Blanket, Solid, Tan" });
  assert.equal(packed.ok, true);
  assert.equal(packed.estimated, true);
  assert.ok(packed.weight > 0 && packed.length > 0);
});

test("a package that cannot fit a carrier is not sent", () => {
  const packed = shippablePackage({
    title: "Steel beam",
    package_length_in: 120,
    package_width_in: 20,
    package_height_in: 20,
    package_weight_lb: 40,
  });
  assert.equal(packed.ok, false);
});
