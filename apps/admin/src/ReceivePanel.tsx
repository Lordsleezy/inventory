import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Options = { next_sku: string | null; categories: unknown; conditions: unknown; test_statuses: unknown; locations: unknown };
type Props = { client: SupabaseClient; storeId: string; onSaved: () => void };
type Form = { brand: string; model: string; title: string; category: string; condition: string;
  testStatus: string; location: string; ask: string; msrp: string; cost: string; floor: string;
  notes: string; upc: string; lot: string; serial: string; quantity: string };
const blank: Form = { brand: '', model: '', title: '', category: '', condition: '', testStatus: '',
  location: '', ask: '', msrp: '', cost: '', floor: '', notes: '', upc: '', lot: '', serial: '', quantity: '1' };
function choices(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') { try { return choices(JSON.parse(value)); } catch { return []; } }
  return [];
}
// Same blank-is-null, two-decimal rule as Floor's parseMoneyToCents.
function cents(input: string): number | null | undefined {
  const text = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!text) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(value) ? value : undefined;
}

export function ReceivePanel({ client, storeId, onSaved }: Props) {
  const [options, setOptions] = useState<Options | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const update = (key: keyof Form, value: string) => setForm(prev => ({ ...prev, [key]: value }));

  async function loadOptions() {
    const { data, error: e } = await client.rpc('portal_receive_options');
    if (e) throw e;
    setOptions(data as Options);
  }
  useEffect(() => { void loadOptions().catch(e => setError(e instanceof Error ? e.message : String(e))); }, [client]);

  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(''); setWarning(''); setSaved([]);
    const quantity = Number(form.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) { setError('Quantity must be 1–100.'); return; }
    const amounts = { ask: cents(form.ask), msrp: cents(form.msrp), cost: cents(form.cost), floor: cents(form.floor) };
    const invalid = Object.entries(amounts).find(([, value]) => value === undefined);
    if (invalid) { setError(`Check the ${invalid[0]} amount. Use dollars and at most two decimals.`); return; }
    if (files.some(file => !file.type.startsWith('image/') || file.size > 15 * 1024 * 1024)) {
      setError('Photos must be images under 15 MB each.'); return;
    }
    setBusy(true);
    try {
      const { data, error: e } = await client.rpc('portal_receive_unit', {
        p_quantity: quantity, p_brand: form.brand.trim(), p_model: form.model.trim(),
        p_title: form.title.trim(), p_category: form.category || null,
        p_condition: form.condition || null, p_test_status: form.testStatus || null,
        p_location: form.location || null, p_ask_cents: amounts.ask,
        p_msrp_cents: amounts.msrp, p_cost_cents: amounts.cost,
        p_floor_cents: amounts.floor, p_notes: form.notes.trim() || null,
        p_upc: form.upc.trim() || null, p_lot: form.lot.trim() || null,
        p_mfr_serial: form.serial.trim() || null
      });
      if (e) throw e;
      const skus = (data as { skus: string[] }).skus;
      setSaved(skus);
      let failed = 0;
      for (const sku of skus) for (const file of files) {
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${storeId}/${sku}/${Date.now()}-${crypto.randomUUID()}-${safe}`;
        try {
          const upload = await client.storage.from('unit-photos').upload(path, file, { contentType: file.type, upsert: false });
          if (upload.error) throw upload.error;
          const linked = await client.rpc('portal_add_unit_photo', { p_sku: sku, p_path: path });
          if (linked.error) throw linked.error;
        } catch { failed++; }
      }
      if (failed) setWarning(`${failed} photo upload(s) did not finish. The unit(s) were received; photos can be added later.`);
      setForm(prev => ({ ...blank, brand: prev.brand, category: prev.category,
        condition: prev.condition, testStatus: prev.testStatus, location: prev.location }));
      setFiles([]); if (fileInput.current) fileInput.current.value = '';
      onSaved();
      await loadOptions().catch(() => setWarning('Units were received. Refresh the page to see the next suggested SKU.'));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const picker = (label: string, key: keyof Form, values: string[]) => <label>{label}<select value={form[key]} onChange={e => update(key, e.target.value)}><option value="">—</option>{values.map(x => <option key={x} value={x}>{x}</option>)}</select></label>;
  const money = (label: string, key: keyof Form) => <label>{label}<input inputMode="decimal" placeholder="Leave blank if unknown" value={form[key]} onChange={e => update(key, e.target.value)} /></label>;
  return <section className="panel receive-panel">
    <div className="receive-next"><div><div className="eyebrow">NEXT AVAILABLE SKU</div><strong>{options?.next_sku || 'Loading…'}</strong></div><p>Each physical item gets its own permanent five-digit SKU. Quantity creates that many units.</p></div>
    {saved.length > 0 && <div className="receive-success"><strong>Received {saved.length === 1 ? 'SKU' : 'SKUs'}: {saved.join(', ')}</strong><p>Write {saved.length === 1 ? 'this number' : 'these numbers'} on the units. The form is ready for the next receive.</p></div>}
    {warning && <p className="hint">{warning}</p>}{error && <div className="alert" role="alert">{error}</div>}
    <form onSubmit={e => void save(e)}><div className="receive-grid">
      <label>Quantity<input type="number" min="1" max="100" step="1" value={form.quantity} onChange={e => update('quantity', e.target.value)} required /></label>
      <label>Brand<input value={form.brand} onChange={e => update('brand', e.target.value)} /></label>
      <label>Model<input value={form.model} onChange={e => update('model', e.target.value)} /></label>
      <label>Title / description<input value={form.title} onChange={e => update('title', e.target.value)} /></label>
      {picker('Category', 'category', choices(options?.categories))}
      {picker('Condition grade', 'condition', choices(options?.conditions))}
      {picker('Test status', 'testStatus', choices(options?.test_statuses))}
      {picker('Location', 'location', choices(options?.locations))}
      {money('Asking price', 'ask')}{money('Item cost', 'cost')}
      {money('Floor price', 'floor')}{money('MSRP', 'msrp')}
      <label>UPC<input value={form.upc} onChange={e => update('upc', e.target.value)} /></label>
      <label>Lot<input value={form.lot} onChange={e => update('lot', e.target.value)} /></label>
      <label>Manufacturer serial<input value={form.serial} onChange={e => update('serial', e.target.value)} /></label>
      <label>Photos (optional)<input ref={fileInput} type="file" accept="image/*" multiple onChange={e => setFiles(Array.from(e.target.files || []))} /></label>
    </div><label className="receive-notes">Defects and notes<textarea rows={3} value={form.notes} onChange={e => update('notes', e.target.value)} /></label>
      <button disabled={busy || !options?.next_sku}>{busy ? 'Receiving…' : 'Receive inventory'}</button>
      <p className="hint">Blank prices remain unknown, not $0. Photos can be added later.</p>
    </form>
  </section>;
}
