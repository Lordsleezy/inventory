import { useCallback, useEffect, useState } from 'react';
import type { WebOrder } from './OrdersPage';

const functionsBase = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');

type Rate = { id: string; amount_cents: number; carrier: string; service: string; days: number | null };
type Quote = {
  order: { paid_shipping_cents: number; paid_service: { carrier: string | null; service: string | null; days: number | null } };
  box: { length_in: number; width_in: number; height_in: number; weight_lb: number };
  rates: Rate[]; selected_id: string; selected_reason: string; messages: string[];
};
type Props = { order: WebOrder; accessToken: string; money: (n: number) => string; onClose: () => void; onDone: () => void };

const field = (v: number | null | undefined) => (v == null ? '' : String(v));

/** Packing-time label: confirm the real box, re-quote live rates, compare with what the customer paid, then buy. */
export function LabelDialog({ order, accessToken, money, onClose, onDone }: Props) {
  const [box, setBox] = useState({ l: field(order.package.length_in), w: field(order.package.width_in), h: field(order.package.height_in), lb: field(order.package.weight_lb) });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [rateId, setRateId] = useState('');
  const [loading, setLoading] = useState(false);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState('');

  const call = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch(`${functionsBase}/.netlify/functions/web-order-admin`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: order.id, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }, [accessToken, order.id]);

  const boxBody = () => ({ length_in: Number(box.l), width_in: Number(box.w), height_in: Number(box.h), weight_lb: Number(box.lb) });
  const boxValid = () => Object.values(boxBody()).every(v => Number.isFinite(v) && v > 0);

  const requote = useCallback(async () => {
    if (!boxValid()) { setError('Enter all four box numbers (length, width, height in inches; weight in pounds).'); return; }
    setLoading(true); setError('');
    try {
      const q = (await call({ action: 'label_quote', box: boxBody() })) as Quote;
      setQuote(q); setRateId(q.selected_id);
    } catch (e) { setQuote(null); setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, box]);

  useEffect(() => { if (boxValid()) void requote(); /* first quote uses the Floor numbers */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = quote?.rates.find(r => r.id === rateId);
  const paid = quote?.order.paid_shipping_cents ?? order.shipping_cents;
  const diff = selected ? selected.amount_cents - paid : 0;
  const stored = order.package;
  const stale = !!quote && (Number(box.l) !== quote.box.length_in || Number(box.w) !== quote.box.width_in || Number(box.h) !== quote.box.height_in || Number(box.lb) !== quote.box.weight_lb);
  const changed = quote && (Number(box.l) !== stored.length_in || Number(box.w) !== stored.width_in || Number(box.h) !== stored.height_in || Number(box.lb) !== stored.weight_lb);

  async function buy() {
    if (!selected) return;
    setBuying(true); setError('');
    try {
      const r = await call({ action: 'buy_label', rate_id: selected.id, box: boxBody() });
      if (r.order?.label_url) window.open(r.order.label_url, '_blank', 'noopener');
      onDone(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBuying(false); }
  }

  return <div className="inventory-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !buying) onClose(); }}>
    <section className="inventory-detail label-dialog" role="dialog" aria-modal="true" aria-label={`Buy label for ${order.order_no}`}>
      <div className="section-head"><div><div className="eyebrow">PACKING</div><h2>Buy label · {order.order_no}</h2></div><button className="secondary" disabled={buying} onClick={onClose}>Close</button></div>
      <p className="hint">{order.title} (SKU {order.sku}) → {[order.ship_city, order.ship_region, order.ship_postal].filter(Boolean).join(', ')}. Nothing is charged until you press Buy.</p>

      <h3>Real box</h3>
      <div className="number-grid">
        <label>Length (in)<input inputMode="decimal" value={box.l} onChange={e => setBox({ ...box, l: e.target.value })} /></label>
        <label>Width (in)<input inputMode="decimal" value={box.w} onChange={e => setBox({ ...box, w: e.target.value })} /></label>
        <label>Height (in)<input inputMode="decimal" value={box.h} onChange={e => setBox({ ...box, h: e.target.value })} /></label>
        <label>Weight (lb)<input inputMode="decimal" value={box.lb} onChange={e => setBox({ ...box, lb: e.target.value })} /></label>
      </div>
      <div className="actions"><button className="secondary" disabled={loading || buying} onClick={() => void requote()}>{loading ? 'Getting live rates…' : quote ? 'Re-quote with these numbers' : 'Get live rates'}</button>
        <span className="hint">Pre-filled from Floor{order.package.weight_lb == null ? ' (no box on file yet)' : ''}. {changed ? 'Your corrected box is saved to the unit as measured when you buy.' : ''}</span></div>

      {error && <div className="alert" role="alert">{error}</div>}

      {quote && <>
        <h3>Live rates, cheapest first</h3>
        <p className="hint">Customer paid {money(paid)} for {quote.order.paid_service.carrier ? `${quote.order.paid_service.carrier} ${quote.order.paid_service.service}` : 'shipping'}{quote.order.paid_service.days ? ` (about ${quote.order.paid_service.days} day${quote.order.paid_service.days === 1 ? '' : 's'})` : ''}. {quote.selected_reason}.</p>
        <div className="rate-list">{quote.rates.map(r => <label key={r.id} className={`rate-row${rateId === r.id ? ' picked' : ''}`}>
          <input type="radio" name="rate" checked={rateId === r.id} onChange={() => setRateId(r.id)} />
          <span><strong>{r.carrier} {r.service}</strong><small>{r.days ? `About ${r.days} business day${r.days === 1 ? '' : 's'}` : 'No delivery estimate'}{r.id === quote.selected_id ? ' · suggested' : ''}</small></span>
          <b>{money(r.amount_cents)}</b></label>)}</div>
        {stale && <div className="alert" role="alert">The box numbers changed. Re-quote before buying so the price matches the real box.</div>}
        {selected && <div className={`label-compare${diff > 0 ? ' loss' : ''}`}>
          <div><span>Customer paid</span><strong>{money(paid)}</strong></div>
          <div><span>This label costs</span><strong>{money(selected.amount_cents)}</strong></div>
          <div><span>Difference</span><strong>{diff > 0 ? `${money(diff)} more than the customer paid` : diff < 0 ? `${money(-diff)} under what the customer paid` : 'Even'}</strong></div>
        </div>}
        <div className="actions"><button disabled={!selected || buying || loading || stale} onClick={() => void buy()}>{buying ? 'Buying…' : selected ? `Buy label · ${money(selected.amount_cents)}` : 'Buy label'}</button></div>
      </>}
    </section>
  </div>;
}
