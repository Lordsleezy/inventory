import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WebOrder } from './OrdersPage';
import { errText } from './errText';
import { floorFunctionUrl } from './floorApi';

type Rate = {
  id: string;
  amount_cents: number;
  carrier: string;
  service: string;
  days: number | null;
  source?: string;
  protection?: string | null;
  raw?: Record<string, unknown>;
};
type SourceStatus = { source: string; online: boolean; rate_count?: number; messages?: string[]; reason?: string | null };
type Quote = {
  order: { paid_shipping_cents: number; channel?: string; paid_service: { carrier: string | null; service: string | null; days: number | null } };
  box: { length_in: number; width_in: number; height_in: number; weight_lb: number };
  rates: Rate[];
  selected_id: string;
  selected_reason: string;
  messages: string[];
  sources?: SourceStatus[];
  label_format?: string;
  multi_sku?: string[] | null;
  stored_box?: { length_in: number | null; width_in: number | null; height_in: number | null; weight_lb: number | null };
};
type Props = {
  order: WebOrder;
  accessToken: string;
  money: (n: number) => string;
  onClose: () => void;
  onDone: () => void;
  /** Compact layout for Floor app shell */
  appMode?: boolean;
};

const field = (v: number | null | undefined) => (v == null ? '' : String(v));
const SOURCE_LABEL: Record<string, string> = {
  shippo: 'Shippo',
  veeqo: 'Veeqo',
  tiktok: 'TikTok Shipping',
  amazon: 'Amazon Shipping',
  ebay_logistics: 'eBay Logistics',
};

function newPurchaseToken() {
  try {
    return crypto.randomUUID();
  } catch {
    return `pt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

/** Packing-time label: confirm box → multi-source quote → confirm → buy → download/print. */
export function LabelDialog({ order, accessToken, money, onClose, onDone, appMode = false }: Props) {
  const [box, setBox] = useState({
    l: field(order.package?.length_in),
    w: field(order.package?.width_in),
    h: field(order.package?.height_in),
    lb: field(order.package?.weight_lb),
  });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [rateId, setRateId] = useState('');
  const [showAllRates, setShowAllRates] = useState(false);
  const [loading, setLoading] = useState(false);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState('');
  const [condition, setCondition] = useState<'ok' | 'not_as_listed' | ''>(
    order.pack_condition === 'ok' || order.pack_condition === 'not_as_listed' ? order.pack_condition : '',
  );
  const [labelFormat, setLabelFormat] = useState<'PDF_4x6' | 'PDF'>('PDF_4x6');
  const [boughtUrl, setBoughtUrl] = useState<string | null>(order.label_url || null);
  const [purchaseToken] = useState(() => newPurchaseToken());
  const channel = (order.channel || 'website').toLowerCase();
  const isWebsite = channel === 'website' || channel === 'web';
  const needsProof = channel === 'amazon' || channel === 'tiktok';

  const call = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch(floorFunctionUrl('web-order-admin'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: order.id, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }, [accessToken, order.id]);

  const boxBody = () => ({ length_in: Number(box.l), width_in: Number(box.w), height_in: Number(box.h), weight_lb: Number(box.lb) });
  const boxValid = () => Object.values(boxBody()).every((v) => Number.isFinite(v) && v > 0);

  const requote = useCallback(async () => {
    if (!boxValid()) {
      setError('Enter all four box numbers (length, width, height in inches; weight in pounds). Quotes never run on a blank.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const q = (await call({ action: 'label_quote', box: boxBody() })) as Quote;
      setQuote(q);
      setRateId(q.selected_id);
      if (q.label_format === 'PDF' || q.label_format === 'PDF_LETTER') setLabelFormat('PDF');
      else setLabelFormat('PDF_4x6');
    } catch (e) {
      setQuote(null);
      setError(errText(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, box]);

  useEffect(() => {
    if (order.label_url) {
      setBoughtUrl(order.label_url);
      return;
    }
    if (boxValid()) void requote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = quote?.rates.find((r) => r.id === rateId);
  const paid = quote?.order.paid_shipping_cents ?? order.shipping_cents;
  const diff = selected ? selected.amount_cents - paid : 0;
  const stale = !!quote && (
    Number(box.l) !== quote.box.length_in
    || Number(box.w) !== quote.box.width_in
    || Number(box.h) !== quote.box.height_in
    || Number(box.lb) !== quote.box.weight_lb
  );
  const visibleRates = useMemo(() => {
    if (!quote) return [];
    if (showAllRates) return quote.rates;
    const top = quote.rates.slice(0, 1);
    if (selected && !top.some((r) => r.id === selected.id)) top.push(selected);
    return top;
  }, [quote, showAllRates, selected]);

  async function buy() {
    if (!selected) return;
    if (isWebsite && condition !== 'ok') return;
    if (!isWebsite && condition === 'not_as_listed') return;
    if (needsProof && !order.pack_proof_photo_path) {
      setError('Add a pack photo on the order before buying a label.');
      return;
    }
    setBuying(true);
    setError('');
    try {
      if (condition === 'ok' || !isWebsite) {
        try { await call({ action: 'pack_condition', status: 'ok' }); } catch { /* non-fatal for marketplace */ }
      }
      await call({ action: 'set_label_format', format: labelFormat });
      const r = await call({
        action: 'buy_label',
        rate_id: selected.id,
        box: boxBody(),
        purchase_token: purchaseToken,
        selected_rate: selected,
        label_format: labelFormat,
      });
      const url = r.label_url || r.order?.label_url || null;
      setBoughtUrl(url);
      if (url) {
        try { window.open(url, '_blank', 'noopener'); } catch { /* ignore */ }
      }
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBuying(false);
    }
  }

  async function voidExisting() {
    if (!window.confirm('Void this label with the carrier and reverse the Floor shipping expense?')) return;
    setBuying(true);
    setError('');
    try {
      await call({ action: 'void_label', force: true });
      setBoughtUrl(null);
      setQuote(null);
      onDone();
      if (boxValid()) await requote();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBuying(false);
    }
  }

  const shellClass = appMode ? 'app-label-dialog' : 'inventory-backdrop';
  const panelClass = appMode ? 'app-stack app-label-panel' : 'inventory-detail label-dialog';

  const body = (
    <section className={panelClass} role="dialog" aria-modal="true" aria-label={`Label for ${order.order_no}`}>
      {!appMode && (
        <div className="section-head">
          <div>
            <div className="eyebrow">SHIPPING LABEL</div>
            <h2>{boughtUrl ? 'Label' : 'Get label'} · {order.order_no}</h2>
          </div>
          <button type="button" className="secondary" disabled={buying} onClick={onClose}>Close</button>
        </div>
      )}
      {appMode && (
        <div className="app-nav">
          <button type="button" disabled={buying} onClick={onClose}>‹ Orders</button>
          <div className="app-nav-title">{boughtUrl ? 'Label' : 'Get label'}</div>
          <button type="button" style={{ visibility: 'hidden' }}>·</button>
        </div>
      )}

      <p className={appMode ? 'app-footer-count' : 'hint'}>
        {(SOURCE_LABEL[channel] || channel)} · {order.title} (SKU {order.sku})
        {quote?.multi_sku?.length ? ` · ${quote.multi_sku.length} units in box` : ''}
        {' → '}
        {[order.ship_city, order.ship_region, order.ship_postal].filter(Boolean).join(', ') || 'no address'}
      </p>

      {boughtUrl ? (
        <>
          <div className={appMode ? 'app-group' : ''}>
            <div className={appMode ? 'app-kv' : 'label-compare'}>
              {appMode ? (
                <>
                  <div className="app-kv"><span>Tracking</span><strong>{order.tracking_number || '—'}</strong></div>
                  <div className="app-kv"><span>Carrier</span><strong>{order.carrier || '—'} {order.service || ''}</strong></div>
                  <div className="app-kv"><span>Label cost</span><strong>{order.label_cost_cents != null ? money(order.label_cost_cents) : '—'}</strong></div>
                </>
              ) : (
                <>
                  <div><span>Tracking</span><strong>{order.tracking_number || '—'}</strong></div>
                  <div><span>Carrier</span><strong>{[order.carrier, order.service].filter(Boolean).join(' ') || '—'}</strong></div>
                  <div><span>Label cost</span><strong>{order.label_cost_cents != null ? money(order.label_cost_cents) : '—'}</strong></div>
                </>
              )}
            </div>
          </div>
          {error && <div className={appMode ? 'app-inline-error' : 'alert'} role="alert">{error}</div>}
          <div className={appMode ? 'app-actions' : 'actions'}>
            <a className={appMode ? '' : 'button'} href={boughtUrl} target="_blank" rel="noreferrer" download>
              Download label
            </a>
            <button type="button" className={appMode ? 'secondary' : 'secondary'} onClick={() => window.open(boughtUrl, '_blank', 'noopener')}>
              Print / Reprint
            </button>
            <button type="button" className="secondary" disabled={buying} onClick={() => void voidExisting()}>
              {buying ? '…' : 'Void label'}
            </button>
          </div>
          <p className={appMode ? 'app-footer-count' : 'hint'}>
            Floor will not buy a second label while this one is active. Void first to re-shop rates.
          </p>
        </>
      ) : (
        <>
          {isWebsite && (
            <>
              <h3>Condition OK?</h3>
              <div className={appMode ? 'app-actions' : 'actions'}>
                <button type="button" className={condition === 'ok' ? '' : 'secondary'} disabled={buying} onClick={() => setCondition('ok')}>OK</button>
                <button
                  type="button"
                  className="secondary"
                  disabled={buying}
                  onClick={async () => {
                    setCondition('not_as_listed');
                    setError('');
                    try {
                      await call({ action: 'pack_condition', status: 'not_as_listed' });
                      setError('Marked not as listed. Do not buy a label.');
                    } catch (e) {
                      setError(errText(e));
                    }
                  }}
                >
                  Not as listed
                </button>
              </div>
            </>
          )}

          <h3>Package (confirm or fix)</h3>
          <div className="number-grid">
            <label>Length (in)<input inputMode="decimal" value={box.l} onChange={(e) => setBox({ ...box, l: e.target.value })} /></label>
            <label>Width (in)<input inputMode="decimal" value={box.w} onChange={(e) => setBox({ ...box, w: e.target.value })} /></label>
            <label>Height (in)<input inputMode="decimal" value={box.h} onChange={(e) => setBox({ ...box, h: e.target.value })} /></label>
            <label>Weight (lb)<input inputMode="decimal" value={box.lb} onChange={(e) => setBox({ ...box, lb: e.target.value })} /></label>
          </div>
          <div className={appMode ? 'app-actions' : 'actions'}>
            <button type="button" className="secondary" disabled={loading || buying} onClick={() => void requote()}>
              {loading ? 'Getting live rates…' : quote ? 'Re-quote' : 'Get live rates'}
            </button>
            <span className={appMode ? 'app-footer-count' : 'hint'}>
              Pre-filled from Floor. Corrected dims save to the unit when you buy.
            </span>
          </div>

          <h3>Label size</h3>
          <div className={appMode ? 'app-actions' : 'actions'}>
            <button type="button" className={labelFormat === 'PDF_4x6' ? '' : 'secondary'} disabled={buying} onClick={() => setLabelFormat('PDF_4x6')}>4×6 thermal</button>
            <button type="button" className={labelFormat === 'PDF' ? '' : 'secondary'} disabled={buying} onClick={() => setLabelFormat('PDF')}>8.5×11</button>
          </div>

          {error && <div className={appMode ? 'app-inline-error' : 'alert'} role="alert">{error}</div>}

          {quote?.sources && (
            <p className={appMode ? 'app-footer-count' : 'hint'}>
              Sources:{' '}
              {quote.sources.map((s) => {
                const name = SOURCE_LABEL[s.source] || s.source;
                return s.online
                  ? `${name} ✓${s.rate_count ? ` (${s.rate_count})` : ''}`
                  : `${name} offline`;
              }).join(' · ')}
            </p>
          )}
          {!!quote?.messages?.length && (
            <p className={appMode ? 'app-footer-count' : 'hint'} style={{ opacity: 0.85 }}>
              {quote.messages.filter((m) => /shippo|veeqo|quota|plan|billing|offline/i.test(m)).slice(0, 3).join(' · ')}
            </p>
          )}

          {quote && selected && (
            <>
              <h3>Confirm</h3>
              <div className={appMode ? 'app-group' : 'label-compare'}>
                {appMode ? (
                  <>
                    <div className="app-kv"><span>Carrier</span><strong>{selected.carrier} {selected.service}</strong></div>
                    <div className="app-kv"><span>Source</span><strong>{SOURCE_LABEL[selected.source || ''] || selected.source || '—'}</strong></div>
                    <div className="app-kv"><span>Est. delivery</span><strong>{selected.days != null ? `~${selected.days} business day${selected.days === 1 ? '' : 's'}` : '—'}</strong></div>
                    <div className="app-kv"><span>Label cost</span><strong>{money(selected.amount_cents)}</strong></div>
                    <div className="app-kv"><span>Buyer paid ship</span><strong>{money(paid)}</strong></div>
                    <div className="app-kv"><span>Difference</span><strong>{diff > 0 ? `${money(diff)} over` : diff < 0 ? `${money(-diff)} under` : 'Even'}</strong></div>
                  </>
                ) : (
                  <>
                    <div><span>Carrier / service</span><strong>{selected.carrier} {selected.service}</strong></div>
                    <div><span>Source</span><strong>{SOURCE_LABEL[selected.source || ''] || selected.source}{selected.protection ? ` · ${selected.protection}` : ''}</strong></div>
                    <div><span>Delivery estimate</span><strong>{selected.days != null ? `About ${selected.days} business day${selected.days === 1 ? '' : 's'}` : 'No estimate'}</strong></div>
                    <div><span>Label cost</span><strong>{money(selected.amount_cents)}</strong></div>
                    <div><span>Buyer paid for shipping</span><strong>{money(paid)}</strong></div>
                    <div><span>Difference</span><strong className={diff > 0 ? 'loss' : ''}>{diff > 0 ? `${money(diff)} more than buyer paid` : diff < 0 ? `${money(-diff)} under` : 'Even'}</strong></div>
                  </>
                )}
              </div>
              <p className={appMode ? 'app-footer-count' : 'hint'}>{quote.selected_reason}</p>

              <button type="button" className="text-button" onClick={() => setShowAllRates((v) => !v)}>
                {showAllRates ? 'Hide other quotes' : `Show all quotes (${quote.rates.length})`}
              </button>
              {showAllRates && (
                <div className="rate-list">
                  {visibleRates.map((r) => (
                    <label key={r.id} className={`rate-row${rateId === r.id ? ' picked' : ''}`}>
                      <input type="radio" name="rate" checked={rateId === r.id} onChange={() => setRateId(r.id)} />
                      <span>
                        <strong>{r.carrier} {r.service}</strong>
                        <small>
                          {SOURCE_LABEL[r.source || ''] || r.source}
                          {r.days != null ? ` · ~${r.days}d` : ''}
                          {r.id === quote.selected_id ? ' · suggested' : ''}
                          {r.protection ? ` · ${r.protection}` : ''}
                        </small>
                      </span>
                      <b>{money(r.amount_cents)}</b>
                    </label>
                  ))}
                </div>
              )}

              {stale && <div className={appMode ? 'app-inline-error' : 'alert'} role="alert">Box numbers changed — re-quote before buying.</div>}
              {needsProof && !order.pack_proof_photo_path && (
                <div className={appMode ? 'app-inline-error' : 'alert'} role="alert">Add a pack photo on this order before Buy.</div>
              )}

              <div className={appMode ? 'app-actions' : 'actions'}>
                <button
                  type="button"
                  disabled={
                    !selected || buying || loading || stale
                    || (isWebsite && condition !== 'ok')
                    || condition === 'not_as_listed'
                    || (needsProof && !order.pack_proof_photo_path)
                  }
                  onClick={() => void buy()}
                >
                  {buying ? 'Buying…' : `Buy · ${money(selected.amount_cents)}`}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );

  if (appMode) return body;
  return (
    <div className={shellClass} onMouseDown={(e) => { if (e.target === e.currentTarget && !buying) onClose(); }}>
      {body}
    </div>
  );
}
