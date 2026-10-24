import assert from "node:assert/strict";
import { planPollUids, normalizeMessageId } from "./gmail-poll-plan.mjs";

const rows = [
  { uid: 1, stored: true },
  { uid: 2, stored: true },
  { uid: 3, stored: false },
  { uid: 4, stored: false },
];

// Oldest stored mail must not crowd out a newer unseen sale.
assert.deepEqual(planPollUids(rows, { limit: 2 }), [4, 3]);

// A full budget of stored mail yields nothing until a rescan is requested.
assert.deepEqual(
  planPollUids(
    [
      { uid: 10, stored: true },
      { uid: 11, stored: true },
    ],
    { limit: 15 },
  ),
  [],
);

// Rescan still prefers fresh mail, then newest stored.
assert.deepEqual(planPollUids(rows, { rescan: true, limit: 3 }), [4, 3, 2]);

assert.equal(normalizeMessageId("<ABC@Depop.com>"), "abc@depop.com");
assert.equal(normalizeMessageId("abc@depop.com"), normalizeMessageId("<abc@depop.com>"));

console.log("gmail-poll-plan.test.mjs ok");
