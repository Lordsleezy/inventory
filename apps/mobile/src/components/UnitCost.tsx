import { useCallback, useEffect, useState } from "react";
import { floorCloud } from "@floor/cloud";
import { friendlyRpc } from "../rpc";

type Info = { missing: boolean; cost_cents: number | null; manager: boolean };
const toCents = (v: string) => {
  const s = v.trim();
  if (!/^\d*(?:\.\d{0,2})?$/.test(s) || s === "" || s === ".") return null;
  return Math.round(Number(s) * 100);
};

/** Acquisition cost — managers only. Clerks leave cost blank for Unfinished pricing. */
export function UnitCost({ sku, ensureOnline }: { sku: string; ensureOnline: () => Promise<void> }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const { data, error: rpcErr } = await floorCloud().rpc("unit_cost_info", { p_sku: sku });
    if (rpcErr) throw rpcErr;
    const next = data as Info;
    setInfo(next);
    setValue(next.cost_cents == null ? "" : (next.cost_cents / 100).toFixed(2));
  }, [sku]);

  useEffect(() => {
    void load().catch((err) => setError(friendlyRpc(err)));
  }, [load]);

  async function save() {
    setError("");
    setSaved(false);
    const cents = toCents(value);
    if (cents === null) { setError("Enter the cost like 12.50."); return; }
    try {
      await ensureOnline();
      const { error: rpcErr } = await floorCloud().rpc("update_unit_field", {
        p_sku: sku,
        p_field: "acquisition_cost_cents",
        p_value: String(cents),
      });
      if (rpcErr) throw rpcErr;
      await load();
      setSaved(true);
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  if (!info) return error ? <p className="text-quiet text-floor-danger">{error}</p> : null;
  if (!info.manager) return null;
  return (
    <div className="mt-2">
      <label className="block">
        <span className="text-body">What we paid {info.missing ? <span className="text-floor-accent">(missing)</span> : null}</span>
        <input className="field mt-1" inputMode="decimal" placeholder="$" value={value}
          onChange={(e) => { setValue(e.target.value); setSaved(false); }} onBlur={() => { if (value.trim() && toCents(value) !== null && toCents(value) !== info.cost_cents) void save(); }} />
      </label>
      {saved ? <p className="text-quiet text-floor-mute">Saved.</p> : null}
      {error ? <p className="text-quiet text-floor-danger">{error}</p> : null}
    </div>
  );
}
