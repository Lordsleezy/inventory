import { cjAdapter, createCjContext } from "./cj.mjs";
import { eproloAdapter } from "./eprolo.mjs";
import { dobaAdapter } from "./doba.mjs";
import { printifyAdapter } from "./printify.mjs";
import { adapterContext } from "../credentials.mjs";

const REGISTRY = {
  cj: cjAdapter,
  eprolo: eproloAdapter,
  doba: dobaAdapter,
  printify: printifyAdapter,
};

export function getAdapter(supplier) {
  const a = REGISTRY[supplier];
  if (!a) throw new Error(`unknown_supplier:${supplier}`);
  return a;
}

export function listAdapters() {
  return Object.values(REGISTRY).map((a) => ({
    id: a.id,
    label: a.label,
    enabled: a.enabled,
    statusHint: a.statusHint || null,
  }));
}

/** Service-role only: decrypted credentials + throttle for CJ. */
export async function openAdapter(storeId, supplier) {
  const adapter = getAdapter(supplier);
  const ctx = await adapterContext(storeId, supplier);
  if (supplier === "cj") return { adapter, ctx: createCjContext(ctx) };
  return { adapter, ctx };
}

export { REGISTRY };
