/** Stub refund helper for card double-sell recovery. */
export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "POST only" };
  }
  return {
    statusCode: 501,
    body: JSON.stringify({ error: "square_refund_stub", detail: "Wire RefundsApi when Square account is live." }),
  };
}
