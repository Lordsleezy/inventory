/** Stub: Square Terminal checkout — not wired until a Terminal is on the counter. */
export async function handler() {
  return {
    statusCode: 501,
    body: JSON.stringify({ error: "square_terminal_not_configured" }),
  };
}
