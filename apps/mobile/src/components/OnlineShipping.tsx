import { useCallback, useEffect, useState } from "react";
import { floorCloud } from "@floor/cloud";
import { friendlyRpc } from "../rpc";

type Status = { ship: boolean; reason: string; override: "ship" | "pickup" | null };
type Pkg = { package_length_in: string; package_width_in: string; package_height_in: string; package_weight_lb: string };
const FIELDS: [keyof Pkg, string][] = [
  ["package_length_in", "Box length (in)"],
  ["package_width_in", "Box width (in)"],
  ["package_height_in", "Box height (in)"],
  ["package_weight_lb", "Box weight (lb)"],
];

/** Website fulfillment for one unit: auto / force ship / pickup only + package dims for live rates. */
export function OnlineShipping({ sku, ensureOnline }: { sku: string; ensureOnline: () => Promise<void> }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [pkg, setPkg] = useState<Pkg>({ package_length_in: "", package_width_in: "", package_height_in: "", package_weight_lb: "" });
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [s, u] = await Promise.all([
      floorCloud().rpc("unit_ship_status", { p_sku: sku }),
      floorCloud().from("units").select("package_length_in,package_width_in,package_height_in,package_weight_lb").eq("sku", sku).maybeSingle(),
    ]);
    if (s.error) throw s.error;
    setStatus(s.data as Status);
    if (u.data) {
      const d = u.data as Record<keyof Pkg, number | null>;
      setPkg(Object.fromEntries(FIELDS.map(([k]) => [k, d[k] == null ? "" : String(d[k])])) as Pkg);
    }
  }, [sku]);

  useEffect(() => {
    void load().catch((err) => setError(friendlyRpc(err)));
  }, [load]);

  async function save(field: string, value: string) {
    setError("");
    if (value.trim() && !(Number(value) > 0) && field !== "fulfillment_override") {
      setError("Use a positive number.");
      return;
    }
    try {
      await ensureOnline();
      const { error: rpcErr } = await floorCloud().rpc("update_unit_field", { p_sku: sku, p_field: field, p_value: value.trim() });
      if (rpcErr) throw rpcErr;
      await load();
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  return (
    <div className="mt-1">
      <label className="block">
        <span className="text-body">Sell online</span>
        <select
          className="field mt-1"
          value={status?.override ?? ""}
          onChange={(e) => void save("fulfillment_override", e.target.value)}
        >
          <option value="">Automatic (ship if size/category allow)</option>
          <option value="ship">Force shippable</option>
          <option value="pickup">Store pickup only</option>
        </select>
      </label>
      <p className="mt-1 text-quiet text-floor-mute">
        {status ? `${status.ship ? "Ship or pickup" : "Pickup only"} — ${status.reason}` : "Checking…"}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {FIELDS.map(([key, label]) => (
          <label key={key} className="block">
            <span className="text-quiet text-floor-mute">{label}</span>
            <input
              className="field mt-1"
              inputMode="decimal"
              value={pkg[key]}
              onChange={(e) => setPkg((p) => ({ ...p, [key]: e.target.value }))}
              onBlur={(e) => void save(key, e.target.value)}
            />
          </label>
        ))}
      </div>
      <p className="mt-1 text-quiet text-floor-mute">Shipping is offered only when all four box numbers are filled in.</p>
      {error ? <p className="mt-1 text-quiet text-floor-danger">{error}</p> : null}
    </div>
  );
}
