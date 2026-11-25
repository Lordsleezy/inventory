import assert from "node:assert/strict";
import { stripOffPlatformContact, composeChannelDescription } from "./listing-copy.mjs";

const raw = "Open Box Industries — Widget.\nThis listing is open box.\nMessage us on Depop if you need more detail before buying. If the item is not as described, reach out and we will make it right.";
assert.equal(stripOffPlatformContact(raw).includes("Depop"), false);
assert.match(stripOffPlatformContact(raw), /Widget/);
const composed = composeChannelDescription({ listingBody: raw, condition: "Open box", sku: "1" });
assert.equal(composed.includes("Depop"), false);
assert.match(composed, /SKU 1/);
console.log("listing-copy-offplatform.test.mjs ok");
