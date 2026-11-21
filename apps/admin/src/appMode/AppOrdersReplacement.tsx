import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { displayProductTitle } from '@floor/store';
import { errText } from '../errText';
import { parseDollars, type SaleHit } from '../dispositions';
import { listThumbPhoto, loadUnitPhotos, signPhotoUrls, type UnitPhoto } from '../unitPhotos';

type Money = (n: number) => string;
type Stamp = (s: string) => string;

type UnitHit = {
  sku: string;
  title: string | null;
  brand: string | null;
  model: string | null;
  state: string;
  ask_cents: number | null;
  condition: string | null;
};

type Props = {
  client: SupabaseClient;
  storeId: string;
  money: Money;
  stamp: Stamp;
  onClose: () => void;
  onDone: () => void;
};

/**
 * Orders + → Replacement. Same record path as Inventory → Replacement
 * (portal_record_replacement), so it shows under Returns → Replacements.
 */
export function AppOrdersReplacement({ client, storeId, money, stamp, onClose, onDone }: Props) {
  const [skuDraft, setSkuDraft] = useState('');
  const [unit, setUnit] = useState<UnitHit | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SaleHit[] | null>(null);
  const [sale, setSale] = useState<SaleHit | null>(null);
  const [bad, setBad] = useState<'yes' | 'not_now' | ''>('');
  const [extra, setExtra] = useState('');
  const [tracking, setTracking] = useState('');
  const [note, setNote] = useState('');
  const [labelFile, setLabelFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ cost_missing: boolean; bad_unit_sku: string | null; id?: string } | null>(null);
  const labelInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!unit) return;
    let alive = true;
    void (async () => {
      const photos: Record<string, UnitPhoto[]> = await loadUnitPhotos(client, storeId, [unit.sku]).catch(
        () => ({}),
      );
      const thumb = listThumbPhoto(photos[unit.sku] || []) as UnitPhoto | null;
      const path = thumb?.path;
      if (!path || !alive) return;
      const signed = await signPhotoUrls(client, [path]);
      if (alive) setThumbUrl(signed[path] || null);
    })();
    return () => { alive = false; };
  }, [client, storeId, unit]);

  useEffect(() => {
    if (!unit) return;
    let alive = true;
    const timer = setTimeout(() => {
      void Promise.resolve(client.rpc('portal_replacement_sale_search', { p_query: query })).then(({ data, error: e }) => {
        if (!alive) return;
        if (e) setError(e.message);
        else { setError(''); setHits((data || []) as SaleHit[]); }
      });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [client, query, unit]);

  async function lookupSku() {
    const sku = skuDraft.trim();
    if (!sku) return;
    setBusy('lookup');
    setError('');
    setUnit(null);
    setThumbUrl(null);
    setSale(null);
    setConfirming(false);
    setResult(null);
    try {
      const { data, error: e } = await client
        .from('units')
        .select('sku,title,brand,model,state,ask_cents,condition')
        .eq('store_id', storeId)
        .eq('sku', sku)
        .maybeSingle();
      if (e) throw e;
      if (!data) throw new Error(`No unit for SKU ${sku}.`);
      if (data.state !== 'available') throw new Error(`SKU ${sku} is ${data.state}, not available.`);
      setUnit(data as UnitHit);
      setSkuDraft(data.sku);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  }

  const extraCents = parseDollars(extra);

  function composedNote() {
    const bits = [
      note.trim(),
      tracking.trim() ? `Tracking ${tracking.trim()}` : '',
      labelFile ? `Label file ${labelFile.name}` : '',
    ].filter(Boolean);
    return bits.join(' · ') || null;
  }

  async function uploadLabelFile(dispositionId: string, sku: string) {
    if (!labelFile) return;
    const safe = labelFile.name.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'label.pdf';
    const path = `${storeId}/replacements/${sku}/${dispositionId}-${safe}`;
    const { error: upErr } = await client.storage.from('order-labels').upload(path, labelFile, {
      contentType: labelFile.type || 'application/pdf',
      upsert: false,
    });
    if (upErr) throw upErr;
  }

  async function record() {
    if (!unit || !sale || !bad || extraCents == null) return;
    setBusy('save');
    setError('');
    try {
      const { data, error: e } = await client.rpc('portal_record_replacement', {
        p_sku: unit.sku,
        p_sale_id: sale.sale_id,
        p_bad_unit_returned: bad === 'yes',
        p_extra_cost_cents: extraCents,
        p_note: composedNote(),
      });
      if (e) throw e;
      const row = data as { id?: string; cost_missing: boolean; bad_unit_sku: string | null };
      if (labelFile && row.id) {
        try {
          await uploadLabelFile(row.id, unit.sku);
        } catch (labelErr) {
          // Replacement is already recorded and linked to Returns; surface label storage only.
          setError(`Replacement saved, but label upload failed: ${errText(labelErr)}`);
        }
      }
      setResult(row);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  }

  const title = unit
    ? displayProductTitle({
        title: unit.title,
        brand: unit.brand,
        model: unit.model,
        fallback: `SKU ${unit.sku}`,
      })
    : '';

  return (
    <div className="app-order-verify-sheet orders-replacement-sheet" role="dialog" aria-modal="true" aria-label="Replacement">
      <div className="returns-nav-bar">
        <button type="button" className="returns-text-btn" onClick={result ? onDone : onClose}>
          {result ? 'Done' : 'Cancel'}
        </button>
        <strong>Replacement</strong>
        <span />
      </div>

      {error && <div className="app-inline-error" role="alert">{error}</div>}

      {result ? (
        <div className="orders-replacement-body">
          <p>
            Recorded. SKU {unit?.sku} left stock and is being delisted. It shows under Returns → Replacements.
            It is not a sale: no revenue, no sales tax.
          </p>
          {result.bad_unit_sku && <p>The bad unit is in Defective as SKU {result.bad_unit_sku}.</p>}
          {result.cost_missing && (
            <p className="returns-hint">This unit has no cost entered yet, so that sale&apos;s payout waits until you enter one.</p>
          )}
          {labelFile && !error && <p className="returns-hint">Shipping label saved with this replacement.</p>}
          <button type="button" className="returns-btn returns-btn-primary" onClick={onDone}>Done</button>
        </div>
      ) : (
        <div className="orders-replacement-body">
          <label className="returns-field">
            Replacement SKU
            <div className="orders-replacement-sku-row">
              <input
                autoFocus={!unit}
                inputMode="numeric"
                value={skuDraft}
                placeholder="Scan or type SKU"
                onChange={(e) => setSkuDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void lookupSku(); }}
              />
              <button type="button" className="returns-btn" disabled={!!busy || !skuDraft.trim()} onClick={() => void lookupSku()}>
                {busy === 'lookup' ? '…' : 'Find'}
              </button>
            </div>
          </label>

          {unit && (
            <div className="orders-replacement-item">
              {thumbUrl
                ? <img src={thumbUrl} alt="" className="orders-replacement-thumb" />
                : <div className="orders-replacement-thumb empty">No photo</div>}
              <div>
                <strong>{title}</strong>
                <small>SKU {unit.sku}{unit.ask_cents != null ? ` · ${money(unit.ask_cents)}` : ''}{unit.condition ? ` · ${unit.condition}` : ''}</small>
              </div>
            </div>
          )}

          {unit && !sale && (
            <>
              <p className="returns-hint">Which sale does this replace? Same search as Returns / Inventory replacements — SKU, sale #, or order #.</p>
              <label className="returns-field">
                Find the sale
                <input
                  type="search"
                  value={query}
                  placeholder="SKU, sale #, order #"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div className="returns-pick-list">
                {hits === null ? <p className="returns-hint">Loading…</p> : hits.length === 0 ? (
                  <div className="app-empty-row">No sale matches.</div>
                ) : hits.map((h) => (
                  <button key={h.sale_id} type="button" className="returns-pick-card" onClick={() => setSale(h)}>
                    <span>
                      <strong>{h.item}</strong>
                      <small>
                        Sale #{h.receipt_no} · SKU {h.sku} · {h.channel} · {stamp(h.sold_at)}
                        {h.order_ref ? ` · order ${h.order_ref}` : ''}
                        {h.buyer ? ` · ${h.buyer}` : ''}
                        {h.replacements ? ` · ${h.replacements} replacement already` : ''}
                      </small>
                    </span>
                    <span className="returns-row-money"><b>{money(h.price_cents)}</b></span>
                  </button>
                ))}
              </div>
            </>
          )}

          {unit && sale && !confirming && (
            <>
              <p className="returns-meta">
                <strong>Replaces</strong> {sale.item} · sale #{sale.receipt_no} · SKU {sale.sku} · {sale.channel} · {stamp(sale.sold_at)}{' '}
                <button type="button" className="returns-text-btn" onClick={() => { setSale(null); setConfirming(false); }}>Change</button>
              </p>

              <fieldset className="orders-replacement-fieldset">
                <legend>Is the bad unit coming back to the store?</legend>
                <label className="inventory-check">
                  <input type="radio" name="bad" checked={bad === 'yes'} onChange={() => setBad('yes')} />
                  Yes (goes into Defective now)
                </label>
                <label className="inventory-check">
                  <input type="radio" name="bad" checked={bad === 'not_now'} onChange={() => setBad('not_now')} />
                  Not now (add it later with &quot;Bad unit came back&quot;)
                </label>
              </fieldset>

              <div className="returns-field-row">
                <span>Shipping label</span>
                <div className="returns-action-row">
                  <button type="button" className="returns-btn" onClick={() => labelInput.current?.click()}>
                    {labelFile ? 'Change label' : 'Upload label'}
                  </button>
                  {labelFile && <small className="returns-hint">{labelFile.name}</small>}
                </div>
              </div>
              <input
                ref={labelInput}
                type="file"
                accept="application/pdf,image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  e.target.value = '';
                  setLabelFile(f);
                }}
              />

              <div className="returns-kv-list">
                <label className="returns-kv-row">
                  <span>Label cost · Paid by us</span>
                  <input inputMode="decimal" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="0.00" />
                </label>
                <label className="returns-kv-row">
                  <span>Tracking #</span>
                  <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="9400…" />
                </label>
                <label className="returns-kv-row">
                  <span>Note</span>
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
                </label>
              </div>
              {extraCents == null && <p className="app-inline-error" role="alert">Enter the label cost as dollars, like 6.50.</p>}
              <p className="returns-hint">
                Label cost comes off the original sale&apos;s profit (same as Inventory → Replacement). Replacement shipping you paid hits expenses on the Returns tab.
              </p>
              <button
                type="button"
                className="returns-btn returns-btn-primary"
                disabled={!bad || extraCents == null}
                onClick={() => setConfirming(true)}
              >
                Review
              </button>
            </>
          )}

          {unit && sale && confirming && (
            <>
              <p>
                SKU {unit.sku} leaves stock and is delisted everywhere. It is not a sale. Its cost
                {extraCents ? ` plus ${money(extraCents)} label` : ''} comes off sale #{sale.receipt_no}, and that sale&apos;s commission is recalculated.
              </p>
              <p>Bad unit: {bad === 'yes' ? 'coming back, goes into Defective now.' : 'not back yet.'}</p>
              {labelFile && <p>Label file: {labelFile.name}</p>}
              {tracking.trim() && <p>Tracking: {tracking.trim()}</p>}
              <div className="returns-action-row">
                <button type="button" className="returns-btn returns-btn-primary" disabled={!!busy} onClick={() => void record()}>
                  {busy === 'save' ? 'Recording…' : 'Confirm replacement'}
                </button>
                <button type="button" className="returns-btn" disabled={!!busy} onClick={() => setConfirming(false)}>Back</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
