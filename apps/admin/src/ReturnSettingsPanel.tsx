import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Props = {
  client: SupabaseClient;
  money: (n: number) => string;
  busy: boolean;
  run: (f: () => Promise<void>) => Promise<void>;
};

type Supplier = {
  id: string;
  name: string;
  accepts_returns: boolean;
  has_us_return_address: boolean;
  return_address_line1?: string | null;
  return_address_city?: string | null;
  return_address_region?: string | null;
  return_address_postal?: string | null;
  return_window_days?: number | null;
  restocking_fee_pct?: number;
  notes?: string | null;
};

const CHANNELS = ['amazon', 'tiktok', 'ebay', 'mercari', 'website', 'depop', 'whatnot', 'facebook', 'other'] as const;

export function ReturnSettingsPanel({ client, money, busy, run }: Props) {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [name, setName] = useState('');
  const [accepts, setAccepts] = useState(false);
  const [hasUs, setHasUs] = useState(false);
  const [windowDays, setWindowDays] = useState('30');
  const [restock, setRestock] = useState('0');
  const [addr1, setAddr1] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postal, setPostal] = useState('');

  const load = useCallback(async () => {
    const [s, sup] = await Promise.all([
      client.rpc('portal_return_settings'),
      client.rpc('portal_suppliers'),
    ]);
    if (s.error) setError(s.error.message);
    else setSettings((s.data as Record<string, unknown>) || {});
    if (!sup.error) setSuppliers((sup.data as Supplier[]) || []);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  function reservePct(ch: string) {
    const map = (settings?.reserve_pct || {}) as Record<string, number>;
    return String(map[ch] ?? 0);
  }

  function setReserve(ch: string, value: string) {
    const n = Number(value);
    setSettings((prev) => {
      const cur = { ...(prev || {}) };
      const map = { ...((cur.reserve_pct as Record<string, number>) || {}) };
      map[ch] = Number.isFinite(n) ? n : 0;
      cur.reserve_pct = map;
      return cur;
    });
  }

  async function saveSettings() {
    await run(async () => {
      setError('');
      const { data, error: e } = await client.rpc('portal_set_return_settings', { p_value: settings });
      if (e) throw new Error(e.message);
      setSettings((data as Record<string, unknown>) || settings);
      setFlash('Return settings saved. Existing listings/prices were not changed.');
    });
  }

  async function addSupplier() {
    if (!name.trim()) {
      setError('Supplier name required.');
      return;
    }
    await run(async () => {
      setError('');
      const { error: e } = await client.rpc('portal_upsert_supplier', {
        p_payload: {
          name: name.trim(),
          accepts_returns: accepts,
          has_us_return_address: hasUs,
          return_address_line1: addr1 || null,
          return_address_city: city || null,
          return_address_region: region || null,
          return_address_postal: postal || null,
          return_window_days: windowDays ? Number(windowDays) : null,
          restocking_fee_pct: Number(restock) || 0,
        },
      });
      if (e) throw new Error(e.message);
      setName('');
      setFlash('Supplier saved. Dropship bot can call supplier_return_policy_check before listing.');
      await load();
    });
  }

  if (!settings) return <section className="panel"><p className="hint">Loading return settings…</p></section>;

  const maxItem = Number(settings.refund_no_return_max_item_cents ?? 1500);

  return (
    <>
      <section className="panel">
        <h2>Returns</h2>
        <p className="hint">
          Reserve % is baked into <em>new</em> Amazon/TikTok list prices only — never rewrites live ask prices.
          Refund-without-return avoids shipping junk back when the label would cost more than the item.
        </p>
        {error && <div className="alert" role="alert">{error}</div>}
        {flash && <div className="notice">{flash}</div>}

        <h3>Return reserve % by channel</h3>
        <div className="number-grid">
          {CHANNELS.map((ch) => (
            <label key={ch}>
              {ch}
              <input value={reservePct(ch)} onChange={(e) => setReserve(ch, e.target.value)} />
            </label>
          ))}
        </div>

        <h3>Refund without return</h3>
        <div className="number-grid">
          <label>
            Max item value ($)
            <input
              value={(maxItem / 100).toFixed(2)}
              onChange={(e) => {
                const cents = Math.round(Number(e.target.value.replace(/[$,\s]/g, '')) * 100);
                setSettings((prev) => ({ ...(prev || {}), refund_no_return_max_item_cents: Number.isFinite(cents) ? cents : 1500 }));
              }}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={settings.refund_no_return_if_label_exceeds_item !== false}
              onChange={(e) => setSettings((prev) => ({ ...(prev || {}), refund_no_return_if_label_exceeds_item: e.target.checked }))}
            />
            Also refund-no-return when label ≥ item
          </label>
        </div>
        <p className="hint">Default threshold: {money(maxItem)}. TikTok decision clock defaults to 48 hours.</p>

        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void saveSettings()}>
            Save return settings
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Dropship suppliers (return routing)</h2>
        <p className="hint">
          If the supplier accepts returns and has a US address, labels go to them and we track credit owed.
          Otherwise refund-without-return (or garage if you choose). No <code>feat/dropship-bot</code> branch was on the remote —
          this table/RPC is the handoff: <code>supplier_return_policy_check(store, supplier)</code>.
        </p>
        <div className="number-grid">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Return window (days)
            <input value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
          </label>
          <label>
            Restocking fee %
            <input value={restock} onChange={(e) => setRestock(e.target.value)} />
          </label>
        </div>
        <div className="check-grid">
          <label>
            <input type="checkbox" checked={accepts} onChange={(e) => setAccepts(e.target.checked)} /> Accepts returns
          </label>
          <label>
            <input type="checkbox" checked={hasUs} onChange={(e) => setHasUs(e.target.checked)} /> US return address
          </label>
        </div>
        {hasUs && (
          <div className="number-grid">
            <label>
              Line 1
              <input value={addr1} onChange={(e) => setAddr1(e.target.value)} />
            </label>
            <label>
              City
              <input value={city} onChange={(e) => setCity(e.target.value)} />
            </label>
            <label>
              State
              <input value={region} onChange={(e) => setRegion(e.target.value)} />
            </label>
            <label>
              ZIP
              <input value={postal} onChange={(e) => setPostal(e.target.value)} />
            </label>
          </div>
        )}
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void addSupplier()}>
            Add supplier
          </button>
        </div>
        <div className="ticket-list" style={{ marginTop: 16 }}>
          {suppliers.map((s) => (
            <div className="ticket" key={s.id}>
              <div className="ticket-top">
                <strong>{s.name}</strong>
                <span>
                  {s.accepts_returns ? 'Accepts returns' : 'No returns'}
                  {s.has_us_return_address ? ' · US address' : ''}
                </span>
              </div>
              <small>
                Window {s.return_window_days ?? '—'}d · restock {s.restocking_fee_pct ?? 0}%
                {s.return_address_line1
                  ? ` · ${s.return_address_line1}, ${s.return_address_city || ''} ${s.return_address_region || ''} ${s.return_address_postal || ''}`
                  : ''}
              </small>
            </div>
          ))}
          {!suppliers.length && <div className="empty">No suppliers yet.</div>}
        </div>
      </section>
    </>
  );
}
