import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import bwipjs from 'bwip-js/browser';
import { scanBarcode } from './barcodeCamera';
import { errText } from './errText';
import { scannerInputMode } from './kiosk';
import { AppItemDetail } from './appMode/AppItemDetail';
import { UnitEditDrawer } from './UnitEditDrawer';
import { rpcMoveLocationStock } from './locationStock';
import { addBulkSkus, bayTitle, layoutBlocked, locationPhrase, planPlaceInBin, slotTagCode, unitsLabel, type LocationAllocation } from './locationPlace';

type Bay = { bay_no: number; row_bins: number[]; name?: string | null };
type Location = { code: string; bay_no: number; row_no: number; bin_no: number | null; stock: number };
type BinItem = { sku: string; title: string; quantity: number; qty_on_hand: number; is_stocked: boolean };
type FoundUnit = {
  sku: string;
  title: string;
  qty_on_hand: number;
  is_stocked: boolean;
  allocations: LocationAllocation[];
};
type Props = {
  client: SupabaseClient;
  storeId: string;
  canManage?: boolean;
  /** Staff may add a new bay. Editing or deleting an existing bay stays with an admin. */
  canAddBay?: boolean;
  variant?: 'app' | 'desktop';
  onBack?: () => void;
  backLabel?: string;
  accessToken?: string;
  money?: (n: number) => string;
  onOpenSku?: (sku: string) => void;
  onSellInStore?: () => void;
  /** Bump to reload bay list (mobile pull-to-refresh). */
  refreshKey?: number;
  onPullReady?: () => void;
};

function friendly(err: unknown) {
  const raw = errText(err);
  if (raw.includes('move_stock_before_removing_location')) return 'Move the stock out before removing that bin.';
  if (raw.includes('not_enough_stock_at_source')) return 'That bin does not have that many.';
  if (raw.includes('not_enough_unassigned')) return 'Not enough unassigned stock.';
  if (raw.includes('sku_not_found')) return 'No item with that SKU.';
  if (raw.includes('manager_required')) return 'Only an admin can change a bay.';
  if (raw.includes('location_not_found')) return 'That bin is not set up.';
  return raw;
}

function Barcode({ code }: { code: string }) {
  const svg = useMemo(() => bwipjs.toSVG({
    bcid: 'code128', text: code, scale: 2, height: 12,
    includetext: false, paddingwidth: 8, paddingheight: 2,
  }), [code]);
  return <div className="location-barcode" aria-label={`Barcode for ${code}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function rowsLabel(count: number) {
  return `${count} row${count === 1 ? '' : 's'}`;
}

export function LocationsPage({
  client, storeId, canManage = true, canAddBay = false, variant = 'desktop', onBack, backLabel = 'More',
  accessToken, money, onOpenSku, onSellInStore, refreshKey = 0, onPullReady,
}: Props) {
  const phone = variant === 'app';
  const [bays, setBays] = useState<Bay[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [screen, setScreen] = useState<'list' | 'bay' | 'bin' | 'edit' | 'scan'>('list');
  const [bayNo, setBayNo] = useState<number | null>(null);
  const [binCode, setBinCode] = useState<string | null>(null);
  const [items, setItems] = useState<BinItem[]>([]);
  const [itemSku, setItemSku] = useState<string | null>(null);
  const [deskDetail, setDeskDetail] = useState<{ unit: Record<string, unknown>; photos: { id: number; path: string; is_primary: boolean }[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [editNo, setEditNo] = useState('1');
  const [editRows, setEditRows] = useState<number[]>([3]);
  const [bulkDraft, setBulkDraft] = useState('');
  const [bulkBay, setBulkBay] = useState('');
  const [bulkRow, setBulkRow] = useState('1');
  const [bulkBin, setBulkBin] = useState('1');
  const [bulkSkus, setBulkSkus] = useState<string[]>([]);
  const [scanValue, setScanValue] = useState('');
  const [pending, setPending] = useState<FoundUnit | null>(null);
  const [scanQty, setScanQty] = useState('1');
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const lock = useRef(false);

  async function refresh() {
    const { data, error: rpcError } = await client.rpc('portal_bay_list');
    if (rpcError) throw rpcError;
    const body = (data || {}) as { bays?: Bay[]; locations?: Location[] };
    const nextBays = body.bays || [];
    setBays(nextBays);
    setBulkBay((current) => (current && nextBays.some((row) => String(row.bay_no) === current) ? current : (nextBays[0] ? String(nextBays[0].bay_no) : '')));
    setLocations(body.locations || []);
    setLoaded(true);
  }

  useEffect(() => {
    let alive = true;
    void refresh().catch((err) => { if (alive) setError(friendly(err)); });
    return () => { alive = false; };
    // The bay list is reloaded after each save as well.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (!refreshKey) return;
    void refresh()
      .catch((err) => setError(friendly(err)))
      .finally(() => onPullReady?.());
  }, [refreshKey, onPullReady]);

  useEffect(() => {
    if (!binCode) return;
    let alive = true;
    void (async () => {
      const { data, error: rpcError } = await client.rpc('portal_location_units', { p_code: binCode });
      if (!alive) return;
      if (rpcError) setError(friendly(rpcError));
      else setItems((data || []) as BinItem[]);
    })();
    return () => { alive = false; };
  }, [client, binCode, screen]);

  useEffect(() => {
    if (screen === 'scan') scanRef.current?.focus();
  }, [screen]);

  useEffect(() => {
    if (!itemSku || phone) {
      setDeskDetail(null);
      return;
    }
    let alive = true;
    void (async () => {
      const { data, error: rpcError } = await client.rpc(canManage ? 'portal_inventory_detail' : 'staff_inventory_detail', { p_sku: itemSku });
      if (!alive) return;
      if (rpcError || !data) {
        setError(rpcError ? friendly(rpcError) : 'Unit not found');
        setItemSku(null);
        return;
      }
      setDeskDetail(data as { unit: Record<string, unknown>; photos: { id: number; path: string; is_primary: boolean }[] });
    })();
    return () => { alive = false; };
  }, [itemSku, phone, client, canManage]);

  const bay = bays.find((row) => row.bay_no === bayNo) || null;
  const bayStock = (no: number) => locations.filter((row) => row.bay_no === no).reduce((sum, row) => sum + Number(row.stock || 0), 0);
  const titleForBay = (no: number | null | undefined) => {
    const found = bays.find((row) => row.bay_no === no);
    return found ? bayTitle(found.bay_no, found.name) : (no ? `Bay ${no}` : 'Locations');
  };
  const spot = locations.find((row) => row.code === binCode) || null;

  function openBay(no: number) {
    setError('');
    setNotice('');
    setBayNo(no);
    setBinCode(null);
    setScreen('bay');
  }

  function openBin(code: string) {
    setError('');
    setNotice('');
    setItems([]);
    setBinCode(code);
    setScreen('bin');
  }

  function startCreate() {
    const next = bays.reduce((max, row) => Math.max(max, row.bay_no), 0) + 1;
    setCreating(true);
    setEditNo(String(next));
    setEditRows([3]);
    setError('');
    setScreen('edit');
  }

  function startEdit() {
    if (!bay) return;
    setCreating(false);
    setEditNo(String(bay.bay_no));
    setEditRows(bay.row_bins.map((count) => Number(count)));
    setError('');
    setScreen('edit');
  }

  async function saveBay() {
    const no = Number(editNo);
    if (!Number.isInteger(no) || no < 1 || no > 9999) {
      setError('Bay number has to be from 1 to 9999.');
      return;
    }
    if (creating && bays.some((row) => row.bay_no === no)) {
      setError('That bay already exists. Open it and tap Edit.');
      return;
    }
    if (!editRows.length || editRows.length > 10 || editRows.some((count) => count < 0 || count > 10)) {
      setError('A bay has 1 to 10 rows, and each row has 0 to 10 bins.');
      return;
    }
    const blocked = layoutBlocked(no, editRows, locations);
    if (blocked) {
      setError(blocked);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { error: rpcError } = await client.rpc('portal_set_bay', { p_bay: no, p_rows: editRows });
      if (rpcError) throw rpcError;
      await refresh();
      setBayNo(no);
      setCreating(false);
      setScreen('bay');
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteBay() {
    if (bayNo == null) return;
    if (bayStock(bayNo) > 0) {
      setError('Move everything out before deleting this bay.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { error: rpcError } = await client.rpc('portal_delete_bay', { p_bay: bayNo });
      if (rpcError) throw rpcError;
      await refresh();
      setBayNo(null);
      setScreen('list');
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }

  function openItem(sku: string) {
    if (accessToken && (money || !phone)) {
      setItemSku(sku);
      return;
    }
    onOpenSku?.(sku);
  }

  async function lookup(raw: string) {
    const code = raw.trim();
    if (!code || !binCode) return;
    const { data, error: rpcError } = await client.rpc('portal_location_unit', { p_sku: code });
    if (rpcError) throw rpcError;
    if (!data) throw new Error('No in-stock item with that SKU.');
    const unit = data as FoundUnit;
    unit.allocations = unit.allocations || [];
    const here = unit.allocations.find((row) => row.location_code === binCode)?.quantity ?? 0;
    const outside = Math.max(0, Number(unit.qty_on_hand) - here);
    if (outside < 1) throw new Error('Those units are already in this bin.');
    if (unit.is_stocked || Number(unit.qty_on_hand) > 1) {
      setPending(unit);
      setScanQty(String(Math.min(outside, Number(unit.qty_on_hand))));
      return;
    }
    await commit(unit, 1);
  }

  async function commit(unit: FoundUnit, quantity: number) {
    if (!binCode) return;
    const moves = planPlaceInBin(unit.qty_on_hand, unit.allocations || [], binCode, quantity);
    for (const move of moves) await rpcMoveLocationStock(client, unit.sku, move.quantity, move.from, move.to);
    setPending(null);
    setScanValue('');
    setNotice(`SKU ${unit.sku} · ${unitsLabel(quantity)} put in ${locationPhrase(binCode)}.`);
    await refresh();
    const { data, error: rpcError } = await client.rpc('portal_location_units', { p_code: binCode });
    if (rpcError) throw rpcError;
    setItems((data || []) as BinItem[]);
    scanRef.current?.focus();
  }

  async function submitScan(raw?: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (pending) {
        const count = Number(scanQty);
        await commit(pending, count);
      } else {
        await lookup(raw ?? scanValue);
      }
    } catch (err) {
      setError(err instanceof Error && !('code' in err) ? err.message : friendly(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function camera() {
    setError('');
    const code = await scanBarcode();
    if (!code) {
      setError('No barcode found. Type the SKU instead.');
      return;
    }
    setScanValue(code);
    await submitScan(code);
  }

  function printLabels() {
    setPrinting(true);
    document.getElementById('floor-location-print-style')?.remove();
    const style = document.createElement('style');
    style.id = 'floor-location-print-style';
    style.textContent = '@page{size:letter;margin:12mm}';
    document.head.appendChild(style);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      style.remove();
      setPrinting(false);
    };
    window.addEventListener('afterprint', done, { once: true });
    window.setTimeout(() => {
      window.print();
      window.setTimeout(done, 120_000);
    }, 50);
  }

  function queueBulk() {
    const next = addBulkSkus(bulkSkus, bulkDraft);
    if (next.length === bulkSkus.length) {
      setError(bulkDraft.trim() ? 'That SKU is already on the list.' : 'Type a SKU first.');
      return;
    }
    setError('');
    setBulkSkus(next);
    setBulkDraft('');
  }

  function bulkSlot() {
    const bay = bays.find((row) => String(row.bay_no) === bulkBay) || null;
    const rowCount = bay?.row_bins.length || 0;
    const rowNo = Math.min(Math.max(Number(bulkRow) || 1, 1), Math.max(rowCount, 1));
    const binCount = bay ? Number(bay.row_bins[rowNo - 1] ?? 0) : 0;
    const binNo = binCount === 0 ? null : Math.min(Math.max(Number(bulkBin) || 1, 1), binCount);
    return { bay, rowCount, rowNo, binCount, binNo };
  }

  async function submitBulk() {
    const slot = bulkSlot();
    if (!slot.bay) { setError('Choose a bay.'); return; }
    if (!bulkSkus.length) { setError('Add at least one SKU.'); return; }
    let code = '';
    try {
      code = slotTagCode(slot.bay.bay_no, slot.rowNo, slot.binCount, slot.binNo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Choose a bin.');
      return;
    }
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const failed: string[] = [];
    const left: string[] = [];
    let placed = 0;
    try {
      for (const sku of bulkSkus) {
        try {
          const { data, error: rpcError } = await client.rpc('portal_location_unit', { p_sku: sku });
          if (rpcError) throw rpcError;
          if (!data) throw new Error('No in-stock item with that SKU.');
          const unit = data as FoundUnit;
          unit.allocations = unit.allocations || [];
          const moves = planPlaceInBin(Number(unit.qty_on_hand), unit.allocations, code, 1);
          for (const move of moves) await rpcMoveLocationStock(client, unit.sku, move.quantity, move.from, move.to);
          placed += 1;
        } catch (err) {
          const message = err instanceof Error && !('code' in err) ? err.message : friendly(err);
          failed.push(`SKU ${sku}: ${message}`);
          left.push(sku);
        }
      }
      setBulkSkus(left);
      if (placed) setNotice(`${placed} tagged in ${locationPhrase(code)}.`);
      if (failed.length) setError(failed.join(' · '));
      await refresh();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  if (itemSku && !phone) {
    if (!deskDetail) return <p className="hint">Loading item…</p>;
    return (
      <UnitEditDrawer
        client={client}
        storeId={storeId}
        sku={itemSku}
        unit={deskDetail.unit}
        photos={deskDetail.photos || []}
        urls={{}}
        accessToken={accessToken || ''}
        canDelete={canManage}
        onClose={() => setItemSku(null)}
        onSaved={() => { void refresh(); }}
        onPhotosChanged={() => undefined}
        onDeleted={() => { setItemSku(null); void refresh(); }}
      />
    );
  }

  if (itemSku && phone && accessToken && money) {
    return (
      <AppItemDetail
        client={client}
        storeId={storeId}
        accessToken={accessToken}
        sku={itemSku}
        money={money}
        canDelete={canManage}
        staffMode={!canManage}
        onBack={() => setItemSku(null)}
        onChanged={() => { void refresh(); }}
        onSellInStore={onSellInStore || (() => undefined)}
      />
    );
  }

  const printSheet = (
    <div className="location-print-sheet">
      {printing && locations.filter((row) => row.bay_no === bayNo).map((row) => (
        <div className="location-label" key={row.code}>
          <strong>{row.code}</strong>
          <Barcode code={row.code} />
        </div>
      ))}
    </div>
  );
  const group = phone ? 'app-group' : 'loc-group';
  const section = phone ? 'app-section-label' : 'loc-section';
  const rowCls = phone ? 'app-row' : 'loc-row';
  const textCls = phone ? 'app-row-text' : 'loc-row-text';
  const sideCls = phone ? 'app-row-price' : 'loc-row-side';
  const chevron = phone ? 'app-chevron' : 'loc-chevron';

  function frame(title: string, subtitle: string | undefined, action: ReactNode, body: ReactNode, back?: () => void, backText?: string) {
    const nav = (
      <div className={phone ? 'app-nav' : 'loc-desk-nav'}>
        {back ? <button type="button" onClick={back}>‹ {backText}</button> : <span />}
        {action || <span />}
      </div>
    );
    const heading = (
      <div className={phone ? 'app-large-title loc-bay-title' : 'loc-desk-title'}>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
    );
    return phone ? (
      <div className="app-stack loc-screen">
        {nav}{heading}
        {error && <p className="loc-error" role="alert">{error}</p>}
        {notice && <p className="loc-notice" role="status">{notice}</p>}
        {body}
        {printSheet}
      </div>
    ) : (
      <section className="locations-simple">
        {nav}{heading}
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="hint" role="status">{notice}</p>}
        {body}
        {printSheet}
      </section>
    );
  }

  function rowButton(label: string, title: string, sub: string | undefined, side: string | undefined, onClick: () => void) {
    return (
      <button type="button" className={rowCls} aria-label={label} onClick={onClick}>
        <span className={textCls}><strong>{title}</strong>{sub && <small>{sub}</small>}</span>
        {side && <span className={sideCls}>{side}</span>}
        <span className={chevron} aria-hidden="true">›</span>
      </button>
    );
  }

  if (screen === 'edit' && (canManage || (canAddBay && creating))) {
    const no = Number(editNo);
    const blocked = Number.isInteger(no) ? layoutBlocked(no, editRows, locations) : null;
    return frame(creating ? 'New bay' : `Edit bay ${editNo}`, '0 bins makes the row a Floor spot for large items.', (
      <button type="button" className="loc-action" disabled={busy} onClick={() => void saveBay()}>{busy ? 'Saving…' : 'Save'}</button>
    ), (
      <>
        <div className={group}>
          <label className="loc-edit-line">
            <span>Bay number</span>
            <input inputMode="numeric" value={editNo} disabled={!creating || busy} onChange={(event) => setEditNo(event.target.value)} />
          </label>
        </div>
        <div className={section}>ROWS</div>
        <div className={group}>
          {editRows.map((bins, index) => (
            <div className={rowCls} key={index}>
              <span className={textCls}>
                <strong>Row {index + 1}</strong>
                <small>{bins === 0 ? 'Floor · large items' : `${bins} bin${bins === 1 ? '' : 's'}`}</small>
              </span>
              <span className="loc-stepper">
                <button type="button" aria-label={`Fewer bins in row ${index + 1}`} disabled={busy || bins <= 0} onClick={() => setEditRows((rows) => rows.map((value, i) => i === index ? value - 1 : value))}>−</button>
                <button type="button" aria-label={`More bins in row ${index + 1}`} disabled={busy || bins >= 10} onClick={() => setEditRows((rows) => rows.map((value, i) => i === index ? value + 1 : value))}>+</button>
              </span>
            </div>
          ))}
        </div>
        <div className="loc-edit-actions">
          {editRows.length < 10 && <button type="button" disabled={busy} onClick={() => setEditRows((rows) => [...rows, 1])}>Add row</button>}
          {editRows.length > 1 && <button type="button" disabled={busy} onClick={() => setEditRows((rows) => rows.slice(0, -1))}>Remove last row</button>}
          {!creating && <button type="button" disabled={busy} onClick={printLabels}>Print labels</button>}
          {!creating && <button type="button" className="danger" disabled={busy || bayStock(no) > 0} onClick={() => void deleteBay()}>Delete bay</button>}
        </div>
        {blocked && <p className={phone ? 'loc-error' : 'error'}>{blocked}</p>}
        {!creating && bayStock(no) > 0 && <p className={phone ? 'loc-notice' : 'hint'}>Move the {unitsLabel(bayStock(no))} out before deleting this bay.</p>}
      </>
    ), () => { setError(''); setScreen(creating ? 'list' : 'bay'); }, creating ? 'Locations' : titleForBay(Number(editNo)));
  }

  if (screen === 'scan' && binCode) {
    return frame('Scan items here', locationPhrase(binCode), null, (
      <>
        <label className="loc-field">SKU
          <span className="loc-scan-line">
            <input
              ref={scanRef}
              value={scanValue}
              inputMode={scannerInputMode()}
              disabled={busy}
              placeholder="Scan or type a SKU"
              onChange={(event) => { setScanValue(event.target.value); setPending(null); }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submitScan(); } }}
            />
            <button type="button" disabled={busy} onClick={() => void camera()}>Scan</button>
          </span>
        </label>
        {pending && (
          <label className="loc-field">How many are going into this bin
            <input inputMode="numeric" type="number" min={1} step={1} value={scanQty} disabled={busy} onChange={(event) => setScanQty(event.target.value)} />
            <small>{pending.title} · SKU {pending.sku} · {unitsLabel(pending.qty_on_hand)} on hand</small>
          </label>
        )}
        <button type="button" className="loc-primary" disabled={busy || (!pending && !scanValue.trim())} onClick={() => void submitScan()}>
          {busy ? 'Saving…' : pending ? 'Put them here' : 'Look up SKU'}
        </button>
      </>
    ), () => { setPending(null); setError(''); setScreen('bin'); }, spot?.bin_no == null ? 'Floor' : `Bin ${binCode}`);
  }

  if (screen === 'bin' && binCode) {
    const count = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0) || Number(spot?.stock || 0);
    const title = spot?.bin_no == null ? 'Floor' : `Bin ${binCode}`;
    return frame(title, `${locationPhrase(binCode)} · ${unitsLabel(count)}`, (
      <button type="button" className="loc-action" onClick={() => { setPending(null); setScanValue(''); setError(''); setScreen('scan'); }}>Scan items here</button>
    ), (
      items.length ? (
        <div className={group}>
          {items.map((item) => rowButton(
            `${item.title}, SKU ${item.sku}, ×${item.quantity}`,
            item.title,
            `SKU ${item.sku}`,
            `×${item.quantity}`,
            () => openItem(item.sku),
          ))}
        </div>
      ) : <p className={phone ? 'app-footer-count' : 'hint'}>Nothing in this bin yet.</p>
    ), () => { setBinCode(null); setScreen('bay'); }, titleForBay(spot?.bay_no ?? bayNo));
  }

  if (screen === 'bay' && bay) {
    return frame(titleForBay(bay.bay_no), `${unitsLabel(bayStock(bay.bay_no))} · ${rowsLabel(bay.row_bins.length)}`, canManage ? (
      <button type="button" className="loc-action" onClick={startEdit}>Edit</button>
    ) : null, (
      <>
        {bay.row_bins.map((bins, index) => {
          const rowNo = index + 1;
          const slots = bins === 0
            ? [locations.find((row) => row.bay_no === bay.bay_no && row.row_no === rowNo && row.bin_no == null)
              || { code: `${bay.bay_no}-${rowNo}`, bay_no: bay.bay_no, row_no: rowNo, bin_no: null, stock: 0 }]
            : Array.from({ length: bins }, (_, binIndex) => locations.find((row) => row.bay_no === bay.bay_no && row.row_no === rowNo && row.bin_no === binIndex + 1)
              || { code: `${bay.bay_no}-${rowNo}-${binIndex + 1}`, bay_no: bay.bay_no, row_no: rowNo, bin_no: binIndex + 1, stock: 0 });
          return (
            <div key={rowNo}>
              <div className={section}>{bins === 0 ? `ROW ${rowNo} · LARGE ITEMS` : `ROW ${rowNo}`}</div>
              <div className={group}>
                {slots.map((slot) => rowButton(
                  slot.bin_no == null ? `Floor, ${unitsLabel(slot.stock)}` : `Bin ${slot.code}, ${unitsLabel(slot.stock)}`,
                  slot.bin_no == null ? 'Floor' : `Bin ${slot.bin_no}`,
                  undefined,
                  unitsLabel(slot.stock),
                  () => openBin(slot.code),
                ))}
              </div>
            </div>
          );
        })}
      </>
    ), () => { setBayNo(null); setScreen('list'); }, 'Locations');
  }

  return (
    <>
      {frame('Locations', undefined, phone ? null : ((canManage || canAddBay) ? (
        <button type="button" className="loc-action" disabled={!loaded || busy} onClick={startCreate}>New bay</button>
      ) : null), (
        <>
        {phone && (canManage || canAddBay) && (
          <button type="button" className="secondary loc-new-bay" disabled={!loaded || busy} onClick={startCreate}>New bay</button>
        )}
        {loaded && bays.length === 0 ? (
          <p className={phone ? 'app-footer-count' : 'hint'}>No bays yet.{(canManage || canAddBay) ? ' Tap New bay to add the first one.' : ''}</p>
        ) : (
          <div className={group}>
            {bays.map((item) => rowButton(
              `${titleForBay(item.bay_no)}, ${rowsLabel(item.row_bins.length)}, ${unitsLabel(bayStock(item.bay_no))}`,
              titleForBay(item.bay_no),
              rowsLabel(item.row_bins.length),
              unitsLabel(bayStock(item.bay_no)),
              () => openBay(item.bay_no),
            ))}
          </div>
        )}
        {phone && (
          <form className="loc-bulk" onSubmit={(event) => { event.preventDefault(); queueBulk(); }}>
            <div className={section}>TAG SKUS</div>
            <label className="loc-field">SKU
              <span className="loc-scan-line">
                <input
                  value={bulkDraft}
                  disabled={busy}
                  placeholder="Type or paste SKUs"
                  autoCapitalize="none"
                  autoCorrect="off"
                  aria-label="SKUs to tag"
                  onChange={(event) => setBulkDraft(event.target.value)}
                />
                <button type="submit" disabled={busy}>Enter</button>
              </span>
            </label>
            <label className="loc-field">Bay
              <select value={bulkBay} disabled={busy || !bays.length} aria-label="Bay" onChange={(event) => { setBulkBay(event.target.value); setBulkRow('1'); setBulkBin('1'); }}>
                {[...bays].sort((a, b) => Number(Boolean(b.name?.trim())) - Number(Boolean(a.name?.trim())) || a.bay_no - b.bay_no).map((item) => <option key={item.bay_no} value={String(item.bay_no)}>{bayTitle(item.bay_no, item.name)}</option>)}
              </select>
            </label>
            <label className="loc-field">Row
              <select value={String(bulkSlot().rowNo)} disabled={busy || !bulkSlot().rowCount} aria-label="Row" onChange={(event) => { setBulkRow(event.target.value); setBulkBin('1'); }}>
                {Array.from({ length: bulkSlot().rowCount }, (_, index) => (
                  <option key={index + 1} value={String(index + 1)}>Row {index + 1}</option>
                ))}
              </select>
            </label>
            <label className="loc-field">Bin
              <select value={bulkSlot().binNo == null ? '' : String(bulkSlot().binNo)} disabled={busy || !bulkSlot().bay} aria-label="Bin" onChange={(event) => setBulkBin(event.target.value)}>
                {bulkSlot().binCount === 0
                  ? <option value="">Floor</option>
                  : Array.from({ length: bulkSlot().binCount }, (_, index) => (
                    <option key={index + 1} value={String(index + 1)}>Bin {index + 1}</option>
                  ))}
              </select>
            </label>
            <ul className="loc-bulk-list" aria-label="SKUs to tag">
              {bulkSkus.length === 0
                ? <li className="empty">Nothing tagged yet.</li>
                : bulkSkus.map((sku) => (
                  <li key={sku}>
                    <span>SKU {sku}</span>
                    <button type="button" disabled={busy} onClick={() => setBulkSkus((rows) => rows.filter((row) => row !== sku))}>Remove</button>
                  </li>
                ))}
            </ul>
            <button type="button" className="loc-bulk-submit" disabled={busy || !bulkSkus.length || !bulkBay} onClick={() => void submitBulk()}>
              {busy ? 'Saving…' : 'Submit'}
            </button>
          </form>
        )}
        </>
      ), onBack, backLabel)}
    </>
  );
}
