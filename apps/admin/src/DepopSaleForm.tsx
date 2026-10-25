import { useEffect, useState } from 'react';
import { floorFunctionUrl } from './floorApi';
import { errText } from './errText';

type Unit = { sku: string; title: string | null; brand: string | null; ask_cents: number | null };
type Props = { accessToken: string; money: (n: number) => string; app?: boolean };

async function call(token: string, body: Record<string, unknown>) {
  const res = await fetch(floorFunctionUrl('listing-manager'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status >= 400 || json.ok === false) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const toCents = (v: string) => (v.trim() === '' ? 0 : Math.round(Number(v) * 100));
const today = () => new Date().toLocaleDateString('en-CA');
const MONEY_FIELDS = [
  ['price', 'Sale price'],
  ['ship', 'Buyer-paid shipping'],
  ['processing', 'Processing fee'],
  ['boosting', 'Boosting fee'],
  ['label', 'Label cost'],
] as const;
type MoneyKey = (typeof MONEY_FIELDS)[number][0];

/** "Record Depop sale": Depop fees are only known from the Depop order page, so they are entered by hand. */
export function DepopSaleForm({ accessToken, money, app }: Props) {
  const [query, setQuery] = useState('');
  const [units, setUnits] = useState<Unit[]>([]);
  const [unit, setUnit] = useState<Unit | null>(null);
  const [amounts, setAmounts] = useState<Record<MoneyKey, string>>({ price: '', ship: '', processing: '', boosting: '', label: '' });
  const [orderNo, setOrderNo] = useState('');
  const [soldOn, setSoldOn] = useState(today());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (unit) return;
    const t = setTimeout(() => {
      call(accessToken, { action: 'depop_sale_units', query })
        .then((r) => setUnits(r.items || []))
        .catch(() => setUnits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [accessToken, query, unit]);

  const valid = unit && orderNo.trim() && amounts.price.trim() !== ''
    && Object.values(amounts).every((v) => v.trim() === '' || (Number.isFinite(Number(v)) && Number(v) >= 0));

  async function save() {
    if (!unit || !valid) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await call(accessToken, {
        action: 'record_depop_sale',
        sku: unit.sku,
        order_number: orderNo.trim(),
        price_cents: toCents(amounts.price),
        buyer_shipping_cents: toCents(amounts.ship),
        processing_fee_cents: toCents(amounts.processing),
        boosting_fee_cents: toCents(amounts.boosting),
        label_cents: toCents(amounts.label),
        sold_at: soldOn,
      });
      if (r.duplicate) {
        setMsg({ ok: false, text: `Depop order ${orderNo.trim()} is already recorded. Nothing was changed.` });
      } else {
        const pulled = (r.pulled || []).filter((p: { ok?: boolean }) => p.ok).length;
        setMsg({ ok: true, text: `Recorded SKU ${unit.sku} sold on Depop for ${money(toCents(amounts.price) / 100)}. Pulled from ${pulled} other channel(s).` });
        setUnit(null);
        setQuery('');
        setOrderNo('');
        setAmounts({ price: '', ship: '', processing: '', boosting: '', label: '' });
        setSoldOn(today());
      }
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  const box = app
    ? { background: '#1c1c1e', borderRadius: 12, padding: 12, margin: '12px 16px', color: '#fff' }
    : { border: '1px solid #ddd', borderRadius: 8, padding: 16, margin: '0 0 16px' };
  const input = { width: '100%', padding: '10px 12px', fontSize: 16, borderRadius: 8, boxSizing: 'border-box' as const,
    border: app ? '1px solid #3a3a3c' : '1px solid #ccc', background: app ? '#2c2c2e' : '#fff', color: app ? '#fff' : undefined };
  const label = { display: 'block', fontSize: 13, margin: '10px 0 4px', opacity: 0.8 };

  return (
    <section style={box} aria-label="Record Depop sale">
      <h2 style={{ margin: 0, fontSize: 18 }}>Record Depop sale</h2>
      <p style={{ margin: '4px 0 0', fontSize: 13, opacity: 0.75 }}>
        Copy the amounts from the Depop order page. Saving marks the unit sold and pulls it from every other channel.
      </p>
      <label style={label} htmlFor="depop-unit">Unit (SKU or search)</label>
      {unit ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ flex: 1 }}><strong>{unit.sku}</strong> {unit.title || unit.brand}</div>
          <button type="button" onClick={() => setUnit(null)}>Change</button>
        </div>
      ) : (
        <>
          <input id="depop-unit" style={input} value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="SKU, title or brand" autoComplete="off" />
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {units.map((u) => (
              <button key={u.sku} type="button" onClick={() => {
                setUnit(u);
                if (!amounts.price && u.ask_cents) setAmounts((a) => ({ ...a, price: (u.ask_cents! / 100).toFixed(2) }));
              }}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 4px', background: 'none',
                  border: 'none', borderBottom: '1px solid rgba(128,128,128,.25)', color: 'inherit', fontSize: 15 }}>
                <strong>{u.sku}</strong> {u.title || u.brand}
              </button>
            ))}
          </div>
        </>
      )}
      {MONEY_FIELDS.map(([k, text]) => (
        <div key={k}>
          <label style={label} htmlFor={`depop-${k}`}>{text}{k === 'price' ? '' : ' (optional)'}</label>
          <input id={`depop-${k}`} style={input} inputMode="decimal" placeholder="0.00" value={amounts[k]}
            onChange={(e) => setAmounts((a) => ({ ...a, [k]: e.target.value }))} />
        </div>
      ))}
      <label style={label} htmlFor="depop-order">Depop order number</label>
      <input id="depop-order" style={input} value={orderNo} onChange={(e) => setOrderNo(e.target.value)} autoComplete="off" />
      <label style={label} htmlFor="depop-date">Sale date</label>
      <input id="depop-date" style={input} type="date" value={soldOn} onChange={(e) => setSoldOn(e.target.value)} />
      <button type="button" disabled={!valid || busy} onClick={save}
        style={{ ...input, marginTop: 14, fontWeight: 600, background: app ? '#0a84ff' : undefined, color: app ? '#fff' : undefined }}>
        {busy ? 'Saving…' : 'Save Depop sale'}
      </button>
      {msg ? <p role="status" style={{ color: msg.ok ? '#30d158' : '#ff453a', margin: '10px 0 0' }}>{msg.text}</p> : null}
    </section>
  );
}
