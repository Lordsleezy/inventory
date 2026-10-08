import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { parseMoneyToCents } from "@floor/store";
import { authErrorMessage, floorCloud } from "@floor/cloud";
import { usePos } from "../pos-context";

function jsonStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      /* ignore */
    }
  }
  return [];
}

export function ReceiveScreen() {
  const { isAdmin, online, refreshUnits, session } = usePos();
  const navigate = useNavigate();
  const [sku, setSku] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [condition, setCondition] = useState("");
  const [location, setLocation] = useState("");
  const [qty, setQty] = useState("1");
  const [ask, setAsk] = useState("");
  const [cost, setCost] = useState("");
  const [floor, setFloor] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [conditions, setConditions] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);

  useEffect(() => {
    void floorCloud()
      .rpc("next_sku")
      .then(({ data }) => setSku(String(data ?? "")));
    void floorCloud()
      .from("store_settings")
      .select("key, value")
      .eq("store_id", session.storeId)
      .in("key", ["categories", "conditions", "locations"])
      .then(({ data }) => {
        for (const row of data ?? []) {
          const list = jsonStringList(row.value);
          if (row.key === "categories") setCategories(list);
          if (row.key === "conditions") setConditions(list);
          if (row.key === "locations") setLocations(list);
        }
      });
  }, [session.storeId]);

  async function save(andAnother: boolean) {
    setBusy(true);
    setError("");
    try {
      const qtyN = Math.max(1, Math.min(9999, Math.round(Number(qty) || 1)));
      const { error: rpcErr } = await floorCloud().rpc("receive_unit", {
        p_sku: sku.trim(),
        p_brand: brand,
        p_model: model,
        p_title: title || [brand, model].filter(Boolean).join(" "),
        p_category: category || null,
        p_condition: condition || null,
        p_location: location || null,
        p_ask_cents: isAdmin ? parseMoneyToCents(ask) ?? null : null,
        p_cost_cents: isAdmin ? parseMoneyToCents(cost) ?? null : null,
        p_floor_cents: isAdmin ? parseMoneyToCents(floor) ?? null : null,
        p_notes: notes || null,
      });
      if (rpcErr) throw rpcErr;
      if (qtyN > 1) {
        const { error: qtyErr } = await floorCloud().rpc("update_unit_field", {
          p_sku: sku.trim(),
          p_field: "qty_on_hand",
          p_value: String(qtyN),
        });
        if (qtyErr) throw qtyErr;
      }
      await refreshUnits();
      if (andAnother) {
        const { data } = await floorCloud().rpc("next_sku");
        setSku(String(data ?? ""));
        setModel("");
        setTitle("");
        setAsk("");
        setCost("");
        setFloor("");
        setNotes("");
        setQty("1");
      } else {
        navigate(`/inventory/${sku.trim()}`);
      }
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page grid" style={{ maxWidth: 640 }}>
      <button type="button" onClick={() => navigate("/inventory")}>
        Back
      </button>
      <h1>Receive unit</h1>
      {!isAdmin ? (
        <p className="muted">Price and cost stay blank so the unit shows in Unfinished for admin pricing.</p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      <label>
        SKU
        <input value={sku} onChange={(e) => setSku(e.target.value)} />
      </label>
      <label>
        Brand
        <input value={brand} onChange={(e) => setBrand(e.target.value)} />
      </label>
      <label>
        Model
        <input value={model} onChange={(e) => setModel(e.target.value)} />
      </label>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="optional" />
      </label>
      <label>
        Category
        {categories.length ? (
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Select…</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input value={category} onChange={(e) => setCategory(e.target.value)} list="recv-categories" />
        )}
        <datalist id="recv-categories">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      <label>
        Condition
        {conditions.length ? (
          <select value={condition} onChange={(e) => setCondition(e.target.value)}>
            <option value="">Select…</option>
            {conditions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input value={condition} onChange={(e) => setCondition(e.target.value)} />
        )}
      </label>
      <label>
        Location
        {locations.length ? (
          <select value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">Select…</option>
            {locations.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Floor, Back room…" />
        )}
      </label>
      <label>
        Quantity (stocked multiples)
        <input
          value={qty}
          inputMode="numeric"
          onChange={(e) => setQty(e.target.value.replace(/\D/g, "").slice(0, 4) || "1")}
        />
      </label>
      {isAdmin ? (
        <>
          <label>
            Ask
            <input value={ask} onChange={(e) => setAsk(e.target.value)} />
          </label>
          <label>
            Cost
            <input value={cost} onChange={(e) => setCost(e.target.value)} />
          </label>
          <label>
            Floor
            <input value={floor} onChange={(e) => setFloor(e.target.value)} />
          </label>
        </>
      ) : null}
      <label>
        Notes
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="row">
        <button type="button" className="primary" disabled={busy || !online} onClick={() => void save(false)}>
          Save
        </button>
        <button type="button" disabled={busy || !online} onClick={() => void save(true)}>
          Save and add another
        </button>
      </div>
    </section>
  );
}
