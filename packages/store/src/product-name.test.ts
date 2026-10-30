import assert from "node:assert/strict";
import test from "node:test";
import { cleanProductIdentity } from "./product-name.ts";

test("cleans seller brand, duplicate words and retail unit junk with corroborated brand", () => {
  const result = cleanProductIdentity({
    brand: "BECKMAN GALLERY & GIFTS",
    model: "Pura Pura Mini Device, 1 EA",
    title: "BECKMAN GALLERY & GIFTS Pura Pura Mini Device, 1 EA",
    description: "Pura Home Mini diffuser with smart fragrance controls.",
  });
  assert.equal(result.brand, "Pura");
  assert.equal(result.model, "Mini Device");
  assert.equal(result.title, "Pura Mini Device");
  assert.ok(result.review);
});

test("rejects seller style brand even when no safe replacement exists", () => {
  const result = cleanProductIdentity({ brand: "North Outlet LLC", model: "Desk Lamp", title: "North Outlet Lamp", description: "A dimmable desk lamp." });
  assert.equal(result.brand, "");
  assert.ok(result.reasons.includes("seller_brand_rejected"));
});

test("preserves real acronyms, strips unit junk, and caps titles at a word boundary", () => {
  const result = cleanProductIdentity({ brand: "Acme", model: "LED Desk Lamp 1 CT", title: "Acme LED Desk Lamp™" });
  assert.equal(result.title, "Acme LED Desk Lamp");
  const long = cleanProductIdentity({ brand: "Acme", model: `${"Very Long Product ".repeat(8)}Lamp`, title: "Acme Product" });
  assert.ok(long.title.length <= 80);
  assert.ok(!long.title.endsWith("Very"));
});

test("preserves meaningful pack and piece counts while removing package abbreviations", () => {
  const result = cleanProductIdentity({
    brand: "Lume",
    model: "Whole Body Deodorant, 3-Pack 1 EA",
    title: "Lume Whole Body Deodorant, 3-Pack 1 EA",
  });
  assert.equal(result.title, "Lume Whole Body Deodorant, 3-Pack");
  assert.ok(!result.title.includes("1 EA"));
});

test("does not report an empty brand as a rejected seller", () => {
  const result = cleanProductIdentity({ brand: "", model: "", title: "Rice Maker", description: "A small kitchen appliance." });
  assert.ok(result.reasons.includes("brand_needs_review"));
  assert.ok(!result.reasons.includes("seller_brand_rejected"));
});

test("strips trademark symbols before compatibility normalization and removes a repeated trailing brand", () => {
  const result = cleanProductIdentity({
    brand: "Hearth & Hand with Magnolia",
    model: "8\"x10\" Rounded Corner Wood Wall Hanging Frame - Hearth & Hand™ with Magnolia",
    title: "8\"x10\" Rounded Corner Wood Wall Hanging Frame - Hearth & Hand™ with Magnolia",
  });
  assert.equal(result.model, '8"x10" Rounded Corner Wood Wall Hanging Frame');
  assert.equal(result.title, 'Hearth & Hand With Magnolia 8"x10" Rounded Corner Wood Wall Hanging Frame');
  assert.ok(!/™|®|\btm\b/i.test(`${result.brand} ${result.model} ${result.title}`));
});
