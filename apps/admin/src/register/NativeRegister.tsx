import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { centsToInput, formatCents, formatCentsTotal, parseMoneyToCents } from '@floor/store';
import type { Customer, TicketQuote, TicketSummary } from '@floor/cloud';
import { cardFeeCents } from '@floor/cloud';
import type { CartLine } from './cart';
import type { RegisterUnit } from './units';
import { unitThumbUrl } from './units';
import type { ReceiptPayload } from './sale';
import { downloadReceiptText, printReceiptHtml, receiptHtml } from './sale';
import { formatPoints } from './CustomerAttach';
import { focusScannerField, isAndroidStoreDevice, isKioskShell, scannerFieldStartsReadOnly, scannerInputMode } from '../kiosk';

const moneyEntry = /^\d*(?:\.\d{0,2})?$/;
const SALE_OVERRIDE = 'Sale price';

export function tenderSuggestions(dueCents: number): number[] {
  if (dueCents <= 0) return [0];
  const exact = dueCents;
  const nextDollar = Math.ceil(dueCents / 100) * 100;
  const next5 = Math.ceil(dueCents / 500) * 500;
  const next20 = Math.ceil(dueCents / 2000) * 2000;
  const next100 = Math.ceil(dueCents / 10000) * 10000;
  return [...new Set([exact, nextDollar, next5, next20, next100].filter(v => v >= dueCents))];
}

function openSquareApp() {
  const tried = window.open('squareup://', '_blank');
  if (!tried) {
    window.location.href = 'https://squareup.com/dashboard';
  }
}

async function scanBarcode(): Promise<string | null> {
  const Detector = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (src: ImageBitmapSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (!Detector) return null;
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const track = stream.getVideoTracks()[0];
    const detector = new Detector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'] });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    await video.play();
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const bitmap = await createImageBitmap(video);
      const codes = await detector.detect(bitmap);
      bitmap.close();
      if (codes[0]?.rawValue) return codes[0].rawValue;
      await new Promise(r => setTimeout(r, 200));
    }
    void track;
    return null;
  } catch {
    return null;
  } finally {
    stream?.getTracks().forEach(t => t.stop());
  }
}

type ManualPayment = {
  quote: TicketQuote;
  args: { paymentMethod: string; cashCents?: number | null; ticketId: string };
  titles: Record<string, { title: string; condition: string | null }>;
};

type DonePanel = {
  summary: TicketSummary;
  changeCents: number | null;
  cashTenderedCents: number | null;
  receipt: ReceiptPayload;
};

export type NativeRegisterProps = {
  lines: CartLine[];
  note: string;
  setNote: (n: string) => void;
  ticketId: string;
  q: string;
  setQ: (v: string) => void;
  showHits: boolean;
  setShowHits: (v: boolean) => void;
  hits: RegisterUnit[];
  searchBusy: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  onSearchKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  addFromSearch: (unit: RegisterUnit) => void;
  idle: boolean;
  busy: boolean;
  cashOpen: boolean;
  error: string;
  loud: string;
  soldByName: string | null;
  customer: Customer | null;
  taxRateBps: number | null;
  itemCount: number;
  rawSubtotal: number;
  discountCents: number;
  discountPct: number;
  tax: number;
  total: number;
  cardFeePreview: number;
  cardFeeBps: number;
  phase: string;
  priceDrafts: Record<string, string>;
  setPriceDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  commitLinePrice: (sku: string, draft: string) => void;
  updateLine: (sku: string, patch: Partial<CartLine>) => void;
  setQty: (sku: string, qty: number) => void;
  removeSku: (sku: string) => void;
  clear: () => void;
  startPay: (kind: 'cash' | 'card' | 'split') => void;
  setDiscountOpen: (v: boolean) => void;
  setDiscountDraft: (v: string) => void;
  setNoteOpen: (v: boolean) => void;
  setCustomerOpen: (v: boolean) => void;
  setEmployeeOpen: (v: boolean) => void;
  setEmployeeDraft: (v: string) => void;
  setEmployeeError: (v: string) => void;
  onCustomUnit: (unit: RegisterUnit, priceCents: number) => void;
  queryUnit: (term: string) => Promise<RegisterUnit[]>;
  children?: ReactNode; // shared modals from parent
};

export function NativeRegisterCart(props: NativeRegisterProps) {
  const {
    lines, note, ticketId, q, setQ, showHits, setShowHits, hits, searchBusy, searchRef,
    onSearchKey, addFromSearch, idle, busy, cashOpen, error, loud, soldByName, customer,
    taxRateBps, itemCount, rawSubtotal, discountCents, discountPct, tax, total, cardFeePreview,
    phase, priceDrafts, setPriceDrafts, commitLinePrice, updateLine, setQty, removeSku, clear,
    startPay, setDiscountOpen, setDiscountDraft, setNoteOpen, setCustomerOpen,
    setEmployeeOpen, setEmployeeDraft, setEmployeeError, onCustomUnit, queryUnit, children,
  } = props;

  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const [editingSku, setEditingSku] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editBaseline, setEditBaseline] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [customTitle, setCustomTitle] = useState('');
  const [customPrice, setCustomPrice] = useState('');
  const [customSku, setCustomSku] = useState('');
  const [customError, setCustomError] = useState('');
  const [customBusy, setCustomBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [swipe, setSwipe] = useState<{ sku: string; x: number } | null>(null);
  const touchOrigin = useRef<{ sku: string; x: number } | null>(null);
  const priceInputRef = useRef<HTMLInputElement>(null);
  const [searchTyping, setSearchTyping] = useState(() => !scannerFieldStartsReadOnly());
  const androidStore = isAndroidStoreDevice();
  const addHit = (unit: RegisterUnit) => {
    if (androidStore) setSearchTyping(false);
    addFromSearch(unit);
  };

  useEffect(() => {
    let cancelled = false;
    for (const line of lines) {
      if (thumbs[line.sku] !== undefined || line.photoUrl) continue;
      void unitThumbUrl(line.sku).then(url => {
        if (!cancelled) setThumbs(prev => (prev[line.sku] !== undefined ? prev : { ...prev, [line.sku]: url }));
      });
    }
    return () => { cancelled = true; };
  }, [lines, thumbs]);

  useEffect(() => {
    if (editingSku) priceInputRef.current?.focus();
  }, [editingSku]);

  function beginEdit(line: CartLine) {
    if (!idle || cashOpen) return;
    const draft = priceDrafts[line.sku] ?? centsToInput(line.priceCents);
    setEditingSku(line.sku);
    setEditDraft(draft);
    setEditBaseline(draft);
  }

  function cancelEdit() {
    setEditingSku(null);
    setEditDraft('');
    setEditBaseline('');
  }

  function finishEdit(sku: string, draft: string, cancelled: boolean) {
    if (cancelled || draft === editBaseline) {
      setPriceDrafts(d => ({ ...d, [sku]: editBaseline || (priceDrafts[sku] ?? '') }));
      cancelEdit();
      return;
    }
    const cleaned = draft === '.' ? '' : draft ? Number(draft === '.' ? 0 : draft || 0).toFixed(2) : '';
    setPriceDrafts(d => ({ ...d, [sku]: cleaned }));
    const cents = parseMoneyToCents(cleaned);
    const line = lines.find(l => l.sku === sku);
    if (line && cents != null && cents >= 0 && cents !== line.priceCents) {
      updateLine(sku, {
        priceCents: cents,
        approvalId: null,
        overrideReason: line.askCents != null && cents === line.askCents ? '' : SALE_OVERRIDE,
      });
    } else {
      commitLinePrice(sku, draft);
      const after = lines.find(l => l.sku === sku);
      if (after && after.askCents != null && after.priceCents !== after.askCents && !after.overrideReason.trim()) {
        updateLine(sku, { overrideReason: SALE_OVERRIDE });
      }
    }
    cancelEdit();
  }

  function resetPrice(line: CartLine) {
    if (line.askCents == null) return;
    updateLine(line.sku, { priceCents: line.askCents, overrideReason: '', approvalId: null });
    setPriceDrafts(d => ({ ...d, [line.sku]: centsToInput(line.askCents!) }));
    cancelEdit();
  }

  async function onCameraScan() {
    if (!idle || cashOpen || scanBusy) return;
    setScanBusy(true);
    try {
      const code = await scanBarcode();
      if (!code) {
        // Android: never programmatic focus (Gboard freeze). User can tap to type.
        if (!androidStore) focusScannerField(searchRef.current, { softKeyboard: searchTyping });
        return;
      }
      setQ(code);
      setShowHits(true);
      const rows = await queryUnit(code);
      if (rows[0]) addHit(rows[0]);
    } finally {
      setScanBusy(false);
    }
  }

  async function submitCustom() {
    setCustomError('');
    const price = parseMoneyToCents(customPrice);
    if (price == null || price < 0) {
      setCustomError('Enter a valid price.');
      return;
    }
    const term = customSku.trim() || customTitle.trim();
    if (!term) {
      setCustomError('Enter a SKU or title from inventory.');
      return;
    }
    setCustomBusy(true);
    try {
      const rows = await queryUnit(term);
      const unit = rows[0];
      if (!unit) {
        setCustomError('No available inventory match. Custom lines must be real SKUs.');
        return;
      }
      onCustomUnit(unit, price);
      setCustomOpen(false);
      setCustomTitle('');
      setCustomPrice('');
      setCustomSku('');
    } finally {
      setCustomBusy(false);
    }
  }

  const cardTotal = total + cardFeePreview;
  const shortTicket = ticketId.slice(0, 8);

  return (
    <div className="admin-register register-app native-register">
      <div className="nr-scroll">
        <div className="nr-top">
          <button
            type="button"
            className="nr-clear"
            disabled={!lines.length || !idle}
            onClick={() => { if (window.confirm('Clear the cart?')) clear(); }}
          >
            Clear
          </button>
          <button
            type="button"
            className="nr-cashier-chip"
            disabled={!idle || cashOpen}
            onClick={() => { setEmployeeDraft(''); setEmployeeError(''); setEmployeeOpen(true); }}
          >
            {soldByName || 'Cashier'} ▾
          </button>
          <button
            type="button"
            className="nr-add-item"
            disabled={!idle || cashOpen}
            onClick={() => { setCustomError(''); setCustomOpen(true); }}
          >
            + Item
          </button>
        </div>

        <div className="nr-title-row">
          <h1>Register</h1>
          <span className="nr-ticket">#{shortTicket}</span>
        </div>

        <div className="nr-search">
          <span className="nr-search-icon" aria-hidden>⌕</span>
          <input
            ref={searchRef}
            placeholder={
              androidStore || isKioskShell()
                ? (searchTyping ? 'Type SKU or title…' : 'Scan or search (tap to type)')
                : 'Scan or search SKU, title'
            }
            value={q}
            onChange={e => {
              setQ(e.target.value);
              setShowHits(Boolean(e.target.value.trim()));
            }}
            onFocus={() => q.trim() && setShowHits(true)}
            onClick={() => {
              if (androidStore || isKioskShell()) {
                setSearchTyping(true);
                requestAnimationFrame(() => focusScannerField(searchRef.current, { softKeyboard: true }));
              }
            }}
            onKeyDown={onSearchKey}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            readOnly={androidStore && !searchTyping}
            inputMode={searchTyping ? 'search' : scannerInputMode()}
            data-hid-wedge={androidStore && !searchTyping ? '1' : undefined}
            disabled={!idle || cashOpen}
          />
          <button
            type="button"
            className="nr-scan-btn"
            disabled={!idle || cashOpen || scanBusy}
            aria-label="Scan barcode"
            onClick={() => void onCameraScan()}
          >
            {scanBusy ? '…' : 'Scan'}
          </button>
          {showHits && (hits.length || searchBusy) ? (
            <div className="nr-hits">
              {searchBusy && !hits.length ? <div className="nr-hit muted">Searching…</div> : null}
              {hits.map(u => (
                <button key={u.sku} type="button" className="nr-hit" onClick={() => addHit(u)}>
                  <span>
                    <strong>{[u.brand, u.model].filter(Boolean).join(' ') || u.title}</strong>
                    <small>SKU {u.sku}{u.condition ? ` · ${u.condition}` : ''}</small>
                  </span>
                  <span>{formatCents(u.askCents) || '—'}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="nr-cart app-group">
          {!lines.length ? (
            <div className="nr-empty">Scan or search to add an item</div>
          ) : (
            lines.map(line => {
              const overridden = line.askCents != null && line.priceCents !== line.askCents;
              const photo = line.photoUrl || thumbs[line.sku];
              const dx = swipe?.sku === line.sku ? swipe.x : 0;
              return (
                <div
                  key={line.sku}
                  className={`nr-line${overridden ? ' overridden' : ''}`}
                  style={{ transform: dx < 0 ? `translateX(${dx}px)` : undefined }}
                  onTouchStart={e => {
                    touchOrigin.current = { sku: line.sku, x: e.touches[0]?.clientX ?? 0 };
                  }}
                  onTouchMove={e => {
                    const o = touchOrigin.current;
                    if (!o || o.sku !== line.sku) return;
                    const x = (e.touches[0]?.clientX ?? 0) - o.x;
                    if (x < -8) setSwipe({ sku: line.sku, x: Math.max(-96, x) });
                  }}
                  onTouchEnd={() => {
                    if (swipe?.sku === line.sku && swipe.x < -64) removeSku(line.sku);
                    setSwipe(null);
                    touchOrigin.current = null;
                  }}
                >
                  <div className="nr-line-main">
                    <span className="nr-thumb">
                      {photo ? <img src={photo} alt="" loading="lazy" decoding="async" /> : null}
                    </span>
                    <span className="nr-line-text">
                      <strong>{line.title}</strong>
                      <small>SKU {line.sku}{line.condition ? ` · ${line.condition}` : ''}</small>
                      {line.qtyOnHand > 1 ? (
                        <span className="nr-stepper">
                          <button type="button" disabled={!idle || cashOpen || line.qty <= 1} onClick={() => setQty(line.sku, line.qty - 1)}>−</button>
                          <span>{line.qty}</span>
                          <button type="button" disabled={!idle || cashOpen || line.qty >= line.qtyOnHand} onClick={() => setQty(line.sku, line.qty + 1)}>+</button>
                        </span>
                      ) : null}
                    </span>
                    <span className="nr-line-price">
                      {editingSku === line.sku ? (
                        <input
                          ref={priceInputRef}
                          className="nr-price-input"
                          type="text"
                          inputMode="decimal"
                          enterKeyHint="done"
                          value={editDraft}
                          onChange={e => {
                            if (!moneyEntry.test(e.target.value)) return;
                            setEditDraft(e.target.value);
                          }}
                          onBlur={() => finishEdit(line.sku, editDraft, false)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              finishEdit(line.sku, editDraft, true);
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className={`nr-price-btn${overridden ? ' is-override' : ''}`}
                          disabled={!idle || cashOpen}
                          onClick={() => beginEdit(line)}
                        >
                          {formatCentsTotal(line.priceCents * (line.qty || 1))}
                          {overridden ? <i aria-hidden>•</i> : null}
                        </button>
                      )}
                      {overridden ? (
                        <button type="button" className="nr-reset-price" disabled={!idle || cashOpen} onClick={() => resetPrice(line)}>
                          Reset
                        </button>
                      ) : null}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="nr-swipe-delete"
                    tabIndex={-1}
                    onClick={() => removeSku(line.sku)}
                  >
                    Delete
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="nr-tools">
          <button
            type="button"
            disabled={!idle || cashOpen}
            onClick={() => { setDiscountDraft(String(discountPct || '')); setDiscountOpen(true); }}
          >
            {discountPct > 0 ? `${discountPct}% off` : 'Discount'}
          </button>
          <button type="button" disabled={!idle || cashOpen} onClick={() => setCustomerOpen(true)}>
            {customer?.name || customer?.phone || 'Customer'}
          </button>
          <button type="button" disabled={!idle} onClick={() => setNoteOpen(true)}>
            {note.trim() ? 'Note ✓' : 'Note'}
          </button>
        </div>

        {loud ? <div className="incident nr-banner">{loud}</div> : null}
        {error && !cashOpen ? <p className="error nr-banner">{error}</p> : null}
      </div>

      <div className="nr-checkout">
        <div className="nr-totals">
          <div><span>Subtotal{itemCount ? ` (${itemCount})` : ''}</span><span>{formatCentsTotal(rawSubtotal)}</span></div>
          {discountCents > 0 || discountPct > 0 ? (
            <div className="discount"><span>Discount</span><span>−{formatCentsTotal(discountCents)}</span></div>
          ) : null}
          <div><span>Tax {taxRateBps != null ? `${(taxRateBps / 100).toFixed(2)}%` : ''}</span><span>{formatCentsTotal(tax)}</span></div>
          <div className="total"><span>Total</span><span>{formatCentsTotal(total)}</span></div>
        </div>

        {!idle ? (
          <p className="muted nr-phase">{phase === 'quoting' ? 'Getting exact total…' : 'Confirm payment…'}</p>
        ) : (
          <>
            <div className="nr-pay">
              <button type="button" className="nr-cash" disabled={busy || !lines.length || cashOpen} onClick={() => void startPay('cash')}>
                <span>Cash</span>
                <strong>{formatCentsTotal(total)}</strong>
              </button>
              <button type="button" className="nr-card" disabled={busy || !lines.length || cashOpen} onClick={() => void startPay('card')}>
                <span>Card</span>
                <strong>{formatCentsTotal(cardTotal)}</strong>
              </button>
            </div>
            <button type="button" className="nr-split" disabled={busy || !lines.length || cashOpen} onClick={() => void startPay('split')}>
              Split cash + card
            </button>
          </>
        )}
      </div>

      {customOpen ? (
        <div className="modal nr-sheet" role="dialog" aria-modal="true" aria-label="Custom item">
          <div className="card grid nr-sheet-card">
            <h2>Add item</h2>
            <p className="muted">Matches inventory by SKU or title, then sets a sale-only price.</p>
            <label>SKU<input value={customSku} onChange={e => setCustomSku(e.target.value)} inputMode="search" autoFocus /></label>
            <label>Title search<input value={customTitle} onChange={e => setCustomTitle(e.target.value)} /></label>
            <label>Sale price<input value={customPrice} onChange={e => setCustomPrice(e.target.value)} inputMode="decimal" placeholder="0.00" /></label>
            {customError ? <p className="error">{customError}</p> : null}
            <div className="row">
              <button type="button" className="secondary" onClick={() => setCustomOpen(false)}>Cancel</button>
              <button type="button" className="primary" disabled={customBusy} onClick={() => void submitCustom()}>
                {customBusy ? 'Looking up…' : 'Add to cart'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {children}
    </div>
  );
}

export type NativeDoneProps = {
  done: DonePanel;
  doneMsg: string;
  setDoneMsg: (m: string) => void;
  newSale: () => void;
  customerEmail?: string | null;
};

export function NativeRegisterDone({ done, doneMsg, setDoneMsg, newSale, customerEmail }: NativeDoneProps) {
  const { summary, changeCents, receipt } = done;
  const method = summary.payment_method === 'split'
    ? 'Split'
    : summary.payment_method === 'card'
      ? 'Card'
      : 'Cash';
  const amount = summary.total_cents;

  function emailReceipt() {
    const to = customerEmail || '';
    const subject = encodeURIComponent(`Receipt ${summary.ticket_id.slice(0, 8)}`);
    const body = encodeURIComponent(
      receipt.lines.map(l => `${l.title}  ${formatCentsTotal(l.priceCents)}`).join('\n')
      + `\n\nTotal ${formatCentsTotal(amount)}\nTicket ${summary.ticket_id}`,
    );
    window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
    setDoneMsg(to ? 'Opening email…' : 'Opening email — add an address in your mail app.');
  }

  return (
    <div className="admin-register register-app native-register nr-done">
      <div className="nr-done-hero">
        <div className="nr-check" aria-hidden>✓</div>
        <h1>Sale complete</h1>
        <strong className="nr-done-amount">{formatCentsTotal(amount)}</strong>
        <p>{method} · Ticket {summary.ticket_id.slice(0, 8)}</p>
        {changeCents != null ? (
          <p className="nr-change">Change due <strong>{formatCentsTotal(changeCents)}</strong></p>
        ) : null}
      </div>

      <div className="app-group nr-receipt-actions">
        <button type="button" className="app-row" onClick={emailReceipt}>
          <span className="app-row-text"><strong>Email receipt</strong></span>
          <span className="app-chevron">›</span>
        </button>
        <button
          type="button"
          className="app-row"
          onClick={() => setDoneMsg(printReceiptHtml(receiptHtml(receipt)) ? 'Print dialog opened.' : 'Could not open print dialog.')}
        >
          <span className="app-row-text"><strong>Print receipt</strong></span>
          <span className="app-chevron">›</span>
        </button>
        <button type="button" className="app-row" onClick={() => downloadReceiptText(receipt)}>
          <span className="app-row-text"><strong>Save as text</strong></span>
          <span className="app-chevron">›</span>
        </button>
      </div>

      <p className="nr-pulled">Inventory pulled · marketplace delist sent</p>
      {summary.points_earned ? (
        <p className="muted nr-banner">+{formatPoints(summary.points_earned)} pts this sale</p>
      ) : null}
      {doneMsg ? <p className="muted nr-banner">{doneMsg}</p> : null}

      <button type="button" className="nr-new-sale" onClick={newSale}>New sale</button>
    </div>
  );
}

export type NativeSheetsProps = {
  app: boolean;
  // cash
  cashOpen: boolean;
  total: number;
  cashDigits: string;
  setCashDigits: (v: string) => void;
  cashTendered: number | null;
  change: number | null;
  pushDigit: (d: string) => void;
  busy: boolean;
  error: string;
  setCashOpen: (v: boolean) => void;
  setError: (v: string) => void;
  runCash: () => void;
  // card
  manual: ManualPayment | null;
  completeManualCard: () => void;
  dismissManual: () => void;
  // split
  splitOpen: boolean;
  setSplitOpen: (v: boolean) => void;
  splitCashDraft: string;
  setSplitCashDraft: (v: string) => void;
  splitCash: number | null | undefined;
  splitBase: number;
  cardFeeBps: number;
  confirmSplit: () => void;
};

/** App-styled cash / card / split sheets. Parent still renders desktop variants when !app. */
export function NativePaySheets(p: NativeSheetsProps) {
  if (!p.app) return null;
  const tenders = tenderSuggestions(p.total);

  return (
    <>
      {p.cashOpen ? (
        <div className="modal nr-sheet" role="dialog" aria-modal="true" aria-label="Cash">
          <div className="card grid nr-sheet-card cash-sheet">
            <h2>Cash</h2>
            <div className="nr-due">
              <span>Amount due</span>
              <strong>{formatCentsTotal(p.total)}</strong>
            </div>
            <label>
              Cash received
              <input
                value={p.cashTendered != null ? (p.cashTendered / 100).toFixed(2) : ''}
                readOnly
                inputMode="decimal"
              />
            </label>
            <div className="nr-tenders">
              {tenders.map(cents => (
                <button key={cents} type="button" className="secondary" disabled={p.busy} onClick={() => p.setCashDigits(String(cents))}>
                  {cents === p.total ? 'Exact' : formatCentsTotal(cents)}
                </button>
              ))}
            </div>
            {p.change != null && p.change >= 0 ? (
              <div className="nr-change-huge">
                <span>Change due</span>
                <strong>{formatCentsTotal(p.change)}</strong>
              </div>
            ) : null}
            {p.error ? <p className="error">{p.error}</p> : null}
            <div className="numpad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(d => (
                <button key={d} type="button" className="secondary" disabled={p.busy} onClick={() => p.pushDigit(d)}>{d}</button>
              ))}
            </div>
            <div className="row">
              <button type="button" className="secondary" disabled={p.busy} onClick={() => { p.setCashOpen(false); p.setCashDigits(''); p.setError(''); }}>Back</button>
              <button
                type="button"
                className="nr-cash"
                disabled={p.busy || p.cashTendered == null || p.cashTendered < p.total}
                onClick={() => p.runCash()}
              >
                {p.busy ? 'Recording…' : 'Complete sale'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {p.manual ? (
        <div className="modal nr-sheet" role="dialog" aria-modal="true" aria-label="Card">
          <div className="card grid nr-sheet-card">
            <h2>Card</h2>
            <div className="nr-charge">
              <span>Charge this amount</span>
              <strong>{formatCentsTotal(p.manual.quote.card_charge_cents)}</strong>
            </div>
            <p className="muted">
              {formatCentsTotal(p.manual.quote.total_cents - p.manual.quote.card_fee_cents)} + card fee {formatCentsTotal(p.manual.quote.card_fee_cents)}
            </p>
            {p.manual.args.paymentMethod === 'split' ? (
              <p>Collect {formatCentsTotal(p.manual.args.cashCents ?? 0)} cash in the drawer first.</p>
            ) : null}
            <ol className="nr-steps">
              <li>Enter exactly that amount in Square</li>
              <li>Customer taps or inserts</li>
              <li>Confirm here after Square says paid</li>
            </ol>
            {p.error ? <p className="error">{p.error}</p> : null}
            <button type="button" className="secondary nr-open-square" onClick={openSquareApp}>Open Square</button>
            <button type="button" className="nr-card-finish" disabled={p.busy} onClick={() => p.completeManualCard()}>
              {p.busy ? 'Recording sale…' : 'Card approved — finish sale'}
            </button>
            <button type="button" className="nr-declined" disabled={p.busy} onClick={p.dismissManual}>
              Card declined
            </button>
          </div>
        </div>
      ) : null}

      {p.splitOpen ? (
        <div className="modal nr-sheet" role="dialog" aria-modal="true" aria-label="Split">
          <div className="card grid nr-sheet-card">
            <h2>Split cash + card</h2>
            <p className="muted">Total {formatCentsTotal(p.total)}. Card fee applies only to the card portion.</p>
            <label>
              Cash portion
              <input value={p.splitCashDraft} onChange={e => p.setSplitCashDraft(e.target.value)} inputMode="decimal" placeholder="0.00" autoFocus />
            </label>
            {typeof p.splitCash === 'number' ? (
              <div className="nr-split-preview">
                <div><span>Card base</span><span>{formatCentsTotal(p.splitBase)}</span></div>
                {p.cardFeeBps > 0 ? (
                  <div><span>Card fee</span><span>{formatCentsTotal(cardFeeCents(p.splitBase, p.cardFeeBps))}</span></div>
                ) : null}
                <div className="total">
                  <span>Charge on card</span>
                  <strong>{formatCentsTotal(p.splitBase + cardFeeCents(p.splitBase, p.cardFeeBps))}</strong>
                </div>
              </div>
            ) : null}
            {p.error ? <p className="error">{p.error}</p> : null}
            <div className="row">
              <button type="button" className="secondary" onClick={() => p.setSplitOpen(false)}>Cancel</button>
              <button type="button" className="nr-card-finish" onClick={() => p.confirmSplit()}>Continue to card</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export { SALE_OVERRIDE };
