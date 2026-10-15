import { asNetlifyFunction } from "../lib/floor-log.mjs";
/** Stub: Square Terminal checkout — not wired until a Terminal is on the counter. */
export async function invoke() {
  return {
    statusCode: 501,
    body: JSON.stringify({ error: "square_terminal_not_configured" }),
  };
}

export default asNetlifyFunction(invoke);
