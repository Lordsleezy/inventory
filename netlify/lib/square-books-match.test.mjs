import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSquarePaymentsToTickets, allocateTicketFee } from "./square-books-match.mjs";

test("matches completed Square cards one-to-one by exact cents and nearest timestamp", () => {
 const tickets=[{ticket_id:"a",sold_at:"2026-10-02T10:00:00Z",card_cents:468737,sale_ids:[1]},{ticket_id:"b",sold_at:"2026-10-03T10:00:00Z",card_cents:1000,sale_ids:[2]}];
 const payments=[{id:"p1",status:"COMPLETED",source_type:"CARD",created_at:"2026-10-02T10:01:00Z",total_money:{amount:468737},processing_fee:[{amount_money:{amount:13743}}],refunded_money:{amount:1200}},{id:"p2",status:"COMPLETED",source_type:"CARD",created_at:"2026-10-04T10:00:00Z",total_money:{amount:500}}];
 const rows=matchSquarePaymentsToTickets(payments,tickets);assert.equal(rows[0].status,"matched");assert.equal(rows[0].ticket_id,"a");assert.equal(rows[0].fee_cents,13743);assert.equal(rows[0].refund_cents,1200);assert.equal(rows[1].status,"unmatched");
});

test("does not auto-match equally close tickets and allocates payment fees to cents", () => {
 const tickets=[{ticket_id:"a",sold_at:"2026-10-02T09:00:00Z",card_cents:1000,sale_ids:[1]},{ticket_id:"b",sold_at:"2026-10-02T11:00:00Z",card_cents:1000,sale_ids:[2]}];
 const rows=matchSquarePaymentsToTickets([{id:"p",status:"COMPLETED",source_type:"CARD",created_at:"2026-10-02T10:00:00Z",total_money:{amount:1000}}],tickets);assert.equal(rows[0].status,"ambiguous");
 const shares=allocateTicketFee(101,[1,2,3],[10,10,10]);assert.deepEqual(shares.map((x)=>x.fee_cents),[34,34,33]);assert.equal(shares.reduce((n,x)=>n+x.fee_cents,0),101);
});
