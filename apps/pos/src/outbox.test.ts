import assert from "node:assert/strict";
import test from "node:test";
import { isDoubleSellFailure, syncOutboxRow, type OutboxRow } from "./outbox.ts";

const row: OutboxRow = {
  id: "1",
  sku: "11116",
  priceCents: 5000,
  taxCents: 400,
  actorId: "user",
  clientSaleId: "client-1",
  createdAt: "2026-09-19T00:00:00Z",
  receiptPayload: "{}",
  status: "pending",
  receiptNo: null,
  error: null,
};

test("sync success reserves then finalizes", async () => {
  const calls: string[] = [];
  const result = await syncOutboxRow(row, {
    reserve: async (sku, channel) => {
      calls.push(`reserve:${sku}:${channel}`);
      return { id: "hold-1" };
    },
    finalize: async (args) => {
      calls.push(`finalize:${args.reservationId}:${args.paymentMethod}`);
      return { receipt_no: "R-9" };
    },
    release: async () => {
      calls.push("release");
    },
  });
  assert.deepEqual(result, { kind: "synced", receiptNo: "R-9" });
  assert.deepEqual(calls, ["reserve:11116:floor", "finalize:hold-1:cash"]);
});

test("already sold is an incident, not a blind retry", async () => {
  const result = await syncOutboxRow(row, {
    reserve: async () => {
      throw new Error("unit_not_sellable");
    },
    finalize: async () => ({ receipt_no: "nope" }),
    release: async () => {},
  });
  assert.equal(result.kind, "incident");
  assert.match(result.message, /INCIDENT/);
  assert.match(result.message, /Do not retry/);
});

test("transient errors stay retryable", async () => {
  const result = await syncOutboxRow(row, {
    reserve: async () => {
      throw new Error("network down");
    },
    finalize: async () => ({ receipt_no: "nope" }),
    release: async () => {},
  });
  assert.equal(result.kind, "retry");
});

test("card is never a double-sell detector miss", () => {
  assert.equal(isDoubleSellFailure(new Error("DOUBLE SALE — this SKU already has a live sale")), true);
});
