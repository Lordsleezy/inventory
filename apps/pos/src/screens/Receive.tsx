import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { parseMoneyToCents } from "@floor/store";
import { authErrorMessage, floorCloud } from "@floor/cloud";
import { usePos } from "../pos-context";

export function ReceiveScreen() {
  const { isAdmin, online, refreshUnits } = usePos();
  const navigate = useNavigate();
  const [sku, setSku] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [condition, setCondition] = useState("");
  const [ask, setAsk] = useState("");
  const [cost, setCost] = useState("");
  const [floor, setFloor] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    void floorCloud()
      .rpc("next_sku")
      .then(({ data }) => setSku(String(data ?? "")));
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <section className="page">
        <p className="error">Only owners and managers can receive inventory.</p>
        <button type="button" onClick={() => navigate("/inventory")}>
          Back
        </button>
      </section>
    );
  }

  async function save(andAnother: boolean) {
    setBusy(true);
    setError("");
    try {
      const { error: rpcErr } = await floorCloud().rpc("receive_unit", {
        p_sku: sku.trim(),
        p_brand: brand,
        p_model: model,
        p_title: title || [brand, model].filter(Boolean).join(" "),
        p_category: category || null,
        p_condition: condition || null,
        p_ask_cents: parseMoneyToCents(ask) ?? null,
        p_cost_cents: parseMoneyToCents(cost) ?? null,
        p_floor_cents: parseMoneyToCents(floor) ?? null,
        p_notes: notes || null,
      });
      if (rpcErr) throw rpcErr;
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
        <input value={category} onChange={(e) => setCategory(e.target.value)} />
      </label>
      <label>
        Condition
        <input value={condition} onChange={(e) => setCondition(e.target.value)} />
      </label>
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
