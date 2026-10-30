import { useState } from 'react';

export function QuantityPicker({ value, onChange, disabled = false, minimum = 1, maximum = 999, label = 'Quantity' }: { value: number | string; onChange: (n: string) => void; disabled?: boolean; minimum?: number; maximum?: number; label?: string }) {
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
  const [typing, setTyping] = useState(false);
  return <label className="quantity-picker">{label}<div className="quantity-picker-controls">
    <select aria-label={`${label} quick select`} disabled={disabled || typing} value={valid && parsed <= 100 ? String(parsed) : ''} onChange={e => { if (e.target.value) onChange(e.target.value); }}>
      <option value="">Choose 1–100…</option>{Array.from({ length: 100 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
    </select>
    <button type="button" className="secondary" disabled={disabled} aria-pressed={typing} onClick={() => setTyping(v => !v)}>{typing ? 'Use list' : 'Type quantity'}</button>
    {typing && <input aria-label={`${label} typed value`} type="number" inputMode="numeric" min={minimum} max={maximum} step={1} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} onBlur={e => { const n = Number(e.target.value); if (!Number.isInteger(n) || n < minimum || n > maximum) onChange(String(minimum)); }} />}
  </div><small>Choose 1–100 or type a whole number up to {maximum}.</small></label>;
}

export function ReceiveQuantity({ value, onChange, disabled = false }: { value: string; onChange: (n: string) => void; disabled?: boolean }) {
  return <fieldset disabled={disabled} className="receive-quantity"><legend>Quantity · one SKU with a count</legend>
    <QuantityPicker value={value} onChange={onChange} disabled={disabled} label="Quantity to receive" />
    <small>Price and entered cost are per unit. Use photos representative of every unit in this batch.</small>
  </fieldset>;
}
