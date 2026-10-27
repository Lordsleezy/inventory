import test from "node:test";
import assert from "node:assert/strict";
import { aspectProblems, canonicalValue, clearInvalid, commonSiblingValue, countUsage, isValidValue, matchAllowedFromText, rankValues, textSuggestions } from "./aspect-suggest.mjs";

const TYPE = { name: "Type", required: true, allowed: ["Sunglasses", "Reading Glasses", "Eyeglasses", "Computer Glasses"], selection_only: false };
const DEPT = { name: "Department", required: true, allowed: ["Men", "Women", "Unisex Adults", "Girls"], selection_only: true };
const COLOR = { name: "Frame Color", required: true, allowed: ["Black", "White", "Brown"], selection_only: false };

test("title words pick the matching allowed value", () => {
  const title = "Foster Grant Design Optics +3.00 Women's reading glasses black";
  assert.equal(matchAllowedFromText(TYPE, title), "Reading Glasses");
  assert.equal(matchAllowedFromText(DEPT, title), "Women");
  assert.equal(matchAllowedFromText(COLOR, title), "Black");
});

test("ambiguous or absent words pick nothing", () => {
  assert.equal(matchAllowedFromText(COLOR, "frame in black and white"), null);
  assert.equal(matchAllowedFromText(DEPT, "reading glasses"), null);
  assert.equal(matchAllowedFromText({ name: "Brand", allowed: ["Acme"] }, "Acme kettle"), null, "identity aspects come from Floor fields, not words");
});

test("textSuggestions only fills blanks", () => {
  const out = textSuggestions([TYPE, DEPT, COLOR], { Department: "Men" }, "Women's black reading glasses");
  assert.deepEqual(out, { Type: "Reading Glasses", "Frame Color": "Black" });
});

test("list-only aspects accept only the list; free-text aspects accept anything non-blank", () => {
  assert.equal(isValidValue(DEPT, "Women"), true);
  assert.equal(isValidValue(DEPT, "Ladies"), false);
  assert.equal(isValidValue(COLOR, "Tortoise"), true);
  assert.equal(isValidValue(COLOR, "  "), false);
  assert.equal(canonicalValue(DEPT, "women"), "Women");
  assert.equal(canonicalValue(DEPT, "ladies"), null);
  assert.equal(canonicalValue(COLOR, "tortoise"), "tortoise");
});

test("most used values come first, then eBay's order", () => {
  const usage = countUsage([{ "Frame Color": "Brown" }, { "Frame Color": "Brown" }, { "Frame Color": "White" }]);
  assert.deepEqual(rankValues(COLOR, usage["Frame Color"]), ["Brown", "White", "Black"]);
  assert.deepEqual(rankValues(DEPT, { Ladies: 9, Women: 2 }), ["Women", "Men", "Unisex Adults", "Girls"], "a list-only aspect never ranks a value eBay does not allow");
});

test("a category change clears only the values that are no longer valid", () => {
  const { kept, cleared } = clearInvalid([DEPT, COLOR], { Department: "Women", "Frame Color": "Tortoise", Material: "Metal", Type: "" });
  assert.deepEqual(kept, { Department: "Women", "Frame Color": "Tortoise" });
  assert.deepEqual(cleared, ["Material"]);
  assert.deepEqual(clearInvalid([DEPT], { Department: "Ladies" }).cleared, ["Department"]);
});

test("missing or not-allowed required values are reported by name", () => {
  assert.deepEqual(aspectProblems([TYPE, DEPT, COLOR], { Type: "Sunglasses", Department: "Ladies" }),
    [{ name: "Department", reason: "not_allowed" }, { name: "Frame Color", reason: "missing" }]);
  assert.deepEqual(aspectProblems([TYPE], { Type: "Sunglasses" }), []);
});

test("same-brand units that are already complete supply the most common value", () => {
  const siblings = [{ Department: "Women" }, { Department: "Women" }, { Department: "Men" }, { Department: "Ladies" }];
  assert.equal(commonSiblingValue(DEPT, siblings), "Women");
  assert.equal(commonSiblingValue(DEPT, [{ Department: "Ladies" }]), null);
});
