import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { nextSku, parseMoneyToCents, receiveUnit } from "@floor/store";
import { useStore } from "../store";
import { Label, Notice } from "../components/ui";

/**
 * Receive one physical unit.
 *
 * The SKU is offered but editable, because sometimes a label has already been
 * written by hand. Either way the number is checked against the permanent
 * ledger when it is saved, so a spent number is refused rather than reused.
 */
export function ReceiveScreen() {
  const { db, settings } = useStore();
  const navigate = useNavigate();

  const [sku, setSku] = useState("");
  const [suggested, setSuggested] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [condition, setCondition] = useState(settings.conditions[0] ?? "");
  const [testStatus, setTestStatus] = useState(settings.testStatuses[0] ?? "");
  const [location, setLocation] = useState(settings.locations[0] ?? "");
  const [cost, setCost] = useState("");
  const [msrp, setMsrp] = useState("");
  const [ask, setAsk] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void nextSku(db).then((next) => {
      setSuggested(next);
      setSku((current) => current || next);
    });
  }, [db]);

  async function save(andAnother: boolean) {
    setError("");

    const money = {
      cost: parseMoneyToCents(cost),
      MSRP: parseMoneyToCents(msrp),
      ask: parseMoneyToCents(ask),
    };
    for (const [name, value] of Object.entries(money)) {
      if (value === undefined) {
        setError(`Check the ${name} amount. It should look like 19.99.`);
        return;
      }
    }

    setSaving(true);
    try {
      const unit = await receiveUnit(db, {
        sku: sku.trim(),
        brand: brand.trim(),
        model: model.trim(),
        title: title.trim(),
        category: category || null,
        condition: condition || null,
        testStatus: testStatus || null,
        location: location || null,
        defectNotes: notes.trim() || null,
        acquisitionCostCents: money.cost ?? null,
        msrpCents: money.MSRP ?? null,
        askCents: money.ask ?? null,
      });

      if (!andAnother) {
        navigate(`/inventory/${unit.sku}`, { replace: true });
        return;
      }

      // Keep the lot-level fields, clear the per-unit ones.
      const next = await nextSku(db);
      setSuggested(next);
      setSku(next);
      setModel("");
      setTitle("");
      setNotes("");
      setAsk("");
      setCost("");
      setMsrp("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h1 className="text-title">Receive a unit</h1>
      <p className="mt-1 text-quiet text-floor-mute">
        One record per physical thing. Five of the same item means five units.
      </p>

      <label className="block py-3">
        <Label>SKU</Label>
        <input
          className="field mt-1 font-mono"
          value={sku}
          inputMode="numeric"
          maxLength={5}
          onChange={(e) => setSku(e.target.value.replace(/\D/g, "").slice(0, 5))}
        />
        {sku !== suggested && suggested ? (
          <button type="button" className="btn-text px-0" onClick={() => setSku(suggested)}>
            Use next number {suggested}
          </button>
        ) : null}
      </label>

      <label className="block py-2">
        <Label>Brand</Label>
        <input className="field mt-1" value={brand} onChange={(e) => setBrand(e.target.value)} />
      </label>

      <label className="block py-2">
        <Label>Model</Label>
        <input className="field mt-1" value={model} onChange={(e) => setModel(e.target.value)} />
      </label>

      <label className="block py-2">
        <Label>Description</Label>
        <input className="field mt-1" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>

      <Picker label="Category" value={category} options={settings.categories} onChange={setCategory} />
      <Picker label="Condition" value={condition} options={settings.conditions} onChange={setCondition} />
      <Picker
        label="Test status"
        value={testStatus}
        options={settings.testStatuses}
        onChange={setTestStatus}
      />
      <Picker label="Location" value={location} options={settings.locations} onChange={setLocation} />

      <div className="grid grid-cols-3 gap-3">
        <Money label="Cost" value={cost} onChange={setCost} />
        <Money label="MSRP" value={msrp} onChange={setMsrp} />
        <Money label="Ask" value={ask} onChange={setAsk} />
      </div>

      <label className="block py-2">
        <Label>Defects and notes</Label>
        <textarea
          className="field mt-1"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>

      <Notice tone="error">{error}</Notice>

      <div className="mt-4 flex items-center gap-4">
        <button type="button" className="btn-accent" disabled={saving} onClick={() => void save(false)}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn-text px-0" disabled={saving} onClick={() => void save(true)}>
          Save and add another
        </button>
      </div>
      <p className="mt-3 text-quiet text-floor-mute">
        Prices can be left blank and filled in later. Blank is not zero.
      </p>
    </section>
  );
}

function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (next: string) => void;
}) {
  return (
    <label className="block py-2">
      <Label>{label}</Label>
      <select className="field mt-1" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function Money({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block py-2">
      <Label>{label}</Label>
      <input
        className="field mt-1"
        value={value}
        inputMode="decimal"
        placeholder="—"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
