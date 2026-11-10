import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';
import { rpcMoveLocationStock } from './locationStock';
import { bayTitle, locationPhrase, planPlaceInBin, planUnassign, unitsLabel, type LocationAllocation } from './locationPlace';

type Bay = { bay_no: number; row_bins: number[]; name?: string | null };
type Spot = { code: string; bay_no: number; row_no: number; bin_no: number | null };
type UnitLoc = {
  sku: string;
  title: string;
  qty_on_hand: number;
  is_stocked: boolean;
  allocations: LocationAllocation[];
};

function friendly(err: unknown) {
  const raw = errText(err);
  if (raw.includes('not_enough_stock_at_source')) return 'That bin does not have that many.';
  if (raw.includes('not_enough_unassigned')) return 'Not enough unassigned stock.';
  if (raw.includes('sku_not_found')) return 'No item with that SKU.';
  return raw;
}

export function LocationPicker({
  client, sku, onClose, onSaved,
}: {
  client: SupabaseClient;
  storeId: string;
  sku: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [bays, setBays] = useState<Bay[]>([]);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [unit, setUnit] = useState<UnitLoc | null>(null);
  const [qty, setQty] = useState('1');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [list, found] = await Promise.all([
        client.rpc('portal_bay_list'),
        client.rpc('portal_location_unit', { p_sku: sku }),
      ]);
      if (!alive) return;
      if (list.error) setError(friendly(list.error));
      const body = (list.data || {}) as { bays?: Bay[]; locations?: Spot[] };
      setBays(body.bays || []);
      setSpots(body.locations || []);
      if (found.error) setError(friendly(found.error));
      else if (found.data) {
        const row = found.data as UnitLoc;
        setUnit(row);
        const outside = Math.max(1, Number(row.qty_on_hand) || 1);
        setQty(String(row.is_stocked || outside > 1 ? 1 : outside));
      }
    })();
    return () => { alive = false; };
  }, [client, sku]);

  const stocked = Boolean(unit && (unit.is_stocked || unit.qty_on_hand > 1));
  const here = new Set((unit?.allocations || []).map((row) => row.location_code));

  async function choose(target: string) {
    if (!unit || busy) return;
    const count = stocked ? Number(qty) : unit.qty_on_hand || 1;
    setError('');
    setBusy(true);
    try {
      const moves = target
        ? planPlaceInBin(unit.qty_on_hand, unit.allocations || [], target, count)
        : planUnassign(unit.allocations || [], count);
      for (const move of moves) {
        await rpcMoveLocationStock(client, unit.sku, move.quantity, move.from, move.to);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error && !('code' in err) ? err.message : friendly(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-stack loc-screen" data-screen="location-picker">
      <div className="app-nav">
        <button type="button" onClick={onClose}>‹ Item</button>
        <span />
      </div>
      <div className="app-large-title loc-bay-title">
        <h1>Location</h1>
        <p>SKU {sku}{unit?.title ? ` · ${unit.title}` : ''}</p>
      </div>
      {error && <p className="loc-error" role="alert">{error}</p>}
      {stocked && (
        <label className="loc-field">How many
          <input inputMode="numeric" type="number" min={1} step={1} value={qty} disabled={busy} onChange={(event) => setQty(event.target.value)} />
        </label>
      )}
      <div className="app-group">
        <button type="button" className="app-row" disabled={busy} onClick={() => void choose('')}>
          <span className="app-row-text"><strong>Unassigned</strong><small>Take it off the shelf</small></span>
          <span className="app-chevron" aria-hidden="true">›</span>
        </button>
      </div>
      {[...bays].sort((a, b) => Number(Boolean(b.name?.trim())) - Number(Boolean(a.name?.trim())) || a.bay_no - b.bay_no).map((bay) => (
        <div key={bay.bay_no}>
          <div className="app-section-label">{bayTitle(bay.bay_no, bay.name)}</div>
          <div className="app-group">
            {bay.row_bins.flatMap((bins, index) => {
              const rowNo = index + 1;
              const namedFloor = Boolean(bay.name?.trim()) && bins === 0 && rowNo === 1;
              if (bins === 0) {
                const code = `${bay.bay_no}-${rowNo}`;
                return [(
                  <button type="button" className="app-row" key={code} disabled={busy} onClick={() => void choose(code)}>
                    <span className="app-row-text">
                      <strong>{namedFloor ? bay.name?.trim() : 'Floor'}</strong>
                      <small>{namedFloor ? (here.has(code) ? 'Here' : 'Floor') : `${locationPhrase(code)}${here.has(code) ? ' · Here' : ''}`}</small>
                    </span>
                    <span className="app-chevron" aria-hidden="true">›</span>
                  </button>
                )];
              }
              return Array.from({ length: bins }, (_, binIndex) => {
                const code = `${bay.bay_no}-${rowNo}-${binIndex + 1}`;
                const spot = spots.find((row) => row.code === code);
                return (
                  <button type="button" className="app-row" key={code} disabled={busy || !spot} onClick={() => void choose(code)}>
                    <span className="app-row-text">
                      <strong>Bin {binIndex + 1}</strong>
                      <small>{locationPhrase(code)}{here.has(code) ? ' · Here' : ''}</small>
                    </span>
                    <span className="app-chevron" aria-hidden="true">›</span>
                  </button>
                );
              });
            })}
          </div>
        </div>
      ))}
      {!bays.length && <p className="app-footer-count">No bays yet.</p>}
      {unit && <p className="app-footer-count">{unitsLabel(unit.qty_on_hand)} on hand. Saving writes a move.</p>}
    </div>
  );
}
