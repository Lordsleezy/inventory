import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLocationAsAskCents, previewLocationAsk, displayAskCents } from "./location-ask.ts";

test("numeric location becomes integer cents", () => {
  assert.equal(parseLocationAsAskCents("999"), 99900);
  assert.equal(parseLocationAsAskCents("27"), 2700);
  assert.equal(parseLocationAsAskCents("27.50"), 2750);
  assert.equal(parseLocationAsAskCents("Warehouse/1099"), 109900);
});

test("non-numeric location is not guessed", () => {
  assert.equal(parseLocationAsAskCents("Floor"), null);
  assert.equal(parseLocationAsAskCents("$999"), null);
  assert.equal(parseLocationAsAskCents("1,399"), null);
  assert.equal(parseLocationAsAskCents("999 dollars"), null);
  assert.equal(parseLocationAsAskCents(""), null);
  assert.equal(parseLocationAsAskCents(null), null);
});

test("displayAskCents prefers ask, else numeric location", () => {
  assert.equal(displayAskCents({ askCents: 59900, location: "999" }), 59900);
  assert.equal(displayAskCents({ askCents: null, location: "999" }), 99900);
  assert.equal(displayAskCents({ askCents: 0, location: "999" }), 99900);
  assert.equal(displayAskCents({ askCents: null, location: "Floor" }), null);
  assert.equal(displayAskCents({ askCents: null, location: null }), null);
});

test("preview migrate skip conflict invalid", () => {
  assert.equal(
    previewLocationAsk({
      sku: "11126",
      brand: "Bosch",
      model: "b36cl80ens/47",
      location: "999",
      askCents: null,
    }).action,
    "migrate",
  );
  assert.equal(
    previewLocationAsk({
      sku: "11134",
      brand: "mora",
      model: "mrt180n6awd",
      location: null,
      askCents: null,
    }).action,
    "skip",
  );
  assert.equal(
    previewLocationAsk({
      sku: "11100",
      brand: "LG",
      model: "x",
      location: "599",
      askCents: 59900,
    }).action,
    "conflict",
  );
  assert.equal(
    previewLocationAsk({
      sku: "11101",
      brand: "LG",
      model: "x",
      location: "Receiving",
      askCents: null,
    }).action,
    "invalid",
  );
});
