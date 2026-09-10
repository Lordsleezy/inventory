import { useState } from "react";
import { centsToInput, formatCents, parseMoneyToCents, sellUnit, type Unit } from "@floor/store";
import { useStore } from "../store";
import { Label, Notice } from "./ui";

/**
 * Mark a unit sold.
 *
 * This does not check first whether the unit is already sold. It asks the
 * database to record the sale and reports whatever the database says, because
 * the database is the only thing that can answer that question correctly.
 */
export function MarkSold({ unit, onSold }: { unit: Unit; onSold: () => Promise<void> | void }) {
  const { db, settings } = useStore();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState(settings.channels[0] ?? "floor");
  const [price, setPrice] = useState(centsToInput(unit.askCents));
  const [method, setMethod] = useState(settings.paymentMethods[0] ?? "");
  const [customer, setCustomer] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError("");
    const cents = parseMoneyToCents(price);
    if (cents === undefined) {
      setError("Check the amount. It should look like 19.99.");
      return;
    }
    if (cents === null) {
      setError("Enter what you actually got for it.");
      return;
    }

    setSaving(true);
    try {
      await sellUnit(db, {
        sku: unit.sku,
        priceCents: cents,
        channel,
        paymentMethod: method || null,
        customerName: customer.trim() || null,
        customerPhone: phone.trim() || null,
        note: note.trim() || null,
      });
      setOpen(false);
      await onSold();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Refresh regardless: if this failed because it sold elsewhere, the
      // screen should stop showing a Sell button.
      await onSold();
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn-accent mt-3" onClick={() => setOpen(true)}>
        Mark sold
      </button>
    );
  }

  return (
    <div className="mt-3 border border-floor-line p-3">
      <p className="text-body">
        Sell {unit.sku}
        {unit.askCents !== null ? (
          <span className="text-floor-mute"> · asking {formatCents(unit.askCents)}</span>
        ) : null}
      </p>

      <label className="block py-2">
        <Label>Channel</Label>
        <select className="field mt-1" value={channel} onChange={(e) => setChannel(e.target.value)}>
          {settings.channels.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="block py-2">
        <Label>Actual price</Label>
        <input
          className="field mt-1"
          value={price}
          inputMode="decimal"
          placeholder="—"
          autoFocus
          onChange={(e) => setPrice(e.target.value)}
        />
      </label>

      <label className="block py-2">
        <Label>Payment</Label>
        <select className="field mt-1" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">—</option>
          {settings.paymentMethods.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="block py-2">
        <Label>Customer (optional)</Label>
        <input className="field mt-1" value={customer} onChange={(e) => setCustomer(e.target.value)} />
      </label>

      <label className="block py-2">
        <Label>Phone (optional)</Label>
        <input
          className="field mt-1"
          value={phone}
          inputMode="tel"
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>

      <label className="block py-2">
        <Label>Note (optional)</Label>
        <input className="field mt-1" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      <Notice tone="error">{error}</Notice>

      <div className="mt-2 flex items-center gap-4">
        <button type="button" className="btn-accent" disabled={saving} onClick={() => void submit()}>
          {saving ? "Recording…" : "Record sale"}
        </button>
        <button type="button" className="btn-text px-0" disabled={saving} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
