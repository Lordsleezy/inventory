import React, { Component, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { centsToInput, formatCents, formatCentsTotal, parseMoneyToCents } from '@floor/store';
import {
  SellError,
  allocateLineTaxes,
  applyTicketDiscount,
  approveWithPin,
  authErrorMessage,
  cardFeeCents,
  finalizeTicket,
  loadStoreSetting,
  loadStoreTaxRateBps,
  quoteTicketTotals,
  type Customer,
  type StaffSession,
  type TicketQuote,
  type TicketSummary,
} from '@floor/cloud';
import { CartProvider, useCart, type CartLine } from './register/cart';
import { CustomerAttach, formatPoints } from './register/CustomerAttach';
import { RegisterSettingsModal } from './register/RegisterSettings';
import {
  DEFAULT_REGISTER_SETTINGS,
  RECEIPT_LEGAL,
  downloadReceiptText,
  loadRegisterSettings,
  printReceiptHtml,
  receiptHtml,
  ticketReceiptPayload,
  withdrawListingsAfterSale,
  type ReceiptPayload,
  type SalePhase,
} from './register/sale';
import { loadAvailableUnits, queryAvailableUnits, searchUnits, type RegisterUnit } from './register/units';
import { NativePaySheets, NativeRegisterCart, NativeRegisterDone, SALE_OVERRIDE } from './register/NativeRegister';
import { isAndroidStoreDevice, isKioskShell, scannerInputMode } from './kiosk';
import { errText } from './errText';

type ManualPayment = {
  quote: TicketQuote;
  args: Parameters<typeof finalizeTicket>[0];
  titles: Record<string, { title: string; condition: string | null }>;
};

type DonePanel = {
  summary: TicketSummary;
  changeCents: number | null;
  cashTenderedCents: number | null;
  receipt: ReceiptPayload;
  customerEmail: string | null;
};

type PinKind = 'below_floor' | 'ticket_discount';
type PayKind = 'cash' | 'card' | 'split';

const moneyEntry = /^\d*(?:\.\d{0,2})?$/;
const cleanMoney = (value: string) => Number(value === '.' ? 0 : value || 0).toFixed(2);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const lineExtendedPrice = (line: CartLine) => line.priceCents * (line.qty || 1);
const EMPLOYEE_CODES: Record<string, string> = { '0000': 'Paul', '1111': 'Jacob' };

function RegisterInner({ staffSession, onNeedFullReload, variant = 'desktop' }: Props) {
  const app = variant === 'app';
  const { lines, note, setNote, ticketId, addUnit, removeSku, updateLine, setQty, clear } = useCart();
  const isAdmin = staffSession.role === 'owner' || staffSession.role === 'manager';
  const manualKey = `floor_manual_${staffSession.storeId}_${staffSession.userId}`;

  const [units, setUnits] = useState<RegisterUnit[]>([]);
  const [remoteHits, setRemoteHits] = useState<RegisterUnit[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [taxRateBps, setTaxRateBps] = useState<number | null>(null);
  const [rewards, setRewards] = useState(DEFAULT_REGISTER_SETTINGS);
  const [q, setQ] = useState('');
  const [showHits, setShowHits] = useState(false);
  const isCoarse = (() => {
    try { return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches; }
    catch { return false; }
  })();
  const [error, setError] = useState('');
  const [loud, setLoud] = useState('');
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<ManualPayment | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(manualKey) || 'null') as ManualPayment | null;
    } catch {
      return null;
    }
  });
  const [phase, setPhase] = useState<SalePhase>(manual ? 'manual_card' : 'idle');
  const confirming = useRef(false);
  const [cashDigits, setCashDigits] = useState('');
  const [cashOpen, setCashOpen] = useState(false);
  const [discountPct, setDiscountPct] = useState(0);
  const [discountApprovalId, setDiscountApprovalId] = useState<string | null>(null);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [discountDraft, setDiscountDraft] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitCashDraft, setSplitCashDraft] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [pinKind, setPinKind] = useState<PinKind | null>(null);
  const [pinSku, setPinSku] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pendingAction, setPendingAction] = useState<PayKind | null>(null);
  const [done, setDone] = useState<DonePanel | null>(null);
  const [doneMsg, setDoneMsg] = useState('');
  const [customerOpen, setCustomerOpen] = useState(false);
  const [soldByCode, setSoldByCode] = useState<string | null>(null);
  const [soldByName, setSoldByName] = useState<string | null>(null);
  const [employeeOpen, setEmployeeOpen] = useState(false);
  const [employeeDraft, setEmployeeDraft] = useState('');
  const [employeeError, setEmployeeError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [receiptLegal, setReceiptLegal] = useState(RECEIPT_LEGAL);
  const [receiptHeader, setReceiptHeader] = useState<string | null>(null);
  const [receiptFooter, setReceiptFooter] = useState<string | null>(null);
  const [qrHeader, setQrHeader] = useState<string | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refreshUnits = useCallback(async () => {
    setUnits(await loadAvailableUnits(80));
  }, []);

  useEffect(() => {
    // Defer inventory warm-load so the Register UI paints first (esp. phones).
    const t = window.setTimeout(() => {
      void refreshUnits().catch(err => setError(authErrorMessage(err)));
    }, 50);
    void loadStoreTaxRateBps().then(setTaxRateBps).catch(() => undefined);
    void loadRegisterSettings().then(setRewards).catch(() => undefined);
    void loadStoreSetting('receipt_branding')
      .then(raw => {
        const parsed =
          typeof raw === 'string'
            ? (JSON.parse(raw) as {
                legal?: string;
                headerMessage?: string | null;
                footerMessage?: string | null;
                qrHeader?: string | null;
                qrCodeDataUrl?: string | null;
              })
            : ((raw as {
                legal?: string;
                headerMessage?: string | null;
                footerMessage?: string | null;
                qrHeader?: string | null;
                qrCodeDataUrl?: string | null;
              } | null) ?? null);
        if (!parsed) return;
        if (parsed.legal?.trim()) setReceiptLegal(parsed.legal.trim());
        setReceiptHeader(parsed.headerMessage?.trim() || null);
        setReceiptFooter(parsed.footerMessage?.trim() || null);
        setQrHeader(parsed.qrHeader?.trim() || null);
        setQrCodeDataUrl(parsed.qrCodeDataUrl || null);
      })
      .catch(() => undefined);
    return () => window.clearTimeout(t);
  }, [refreshUnits]);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setRemoteHits([]);
      setSearchBusy(false);
      return;
    }
    let cancelled = false;
    setSearchBusy(true);
    const t = window.setTimeout(() => {
      void queryAvailableUnits(term, 16)
        .then(rows => { if (!cancelled) setRemoteHits(rows); })
        .catch(err => { if (!cancelled) setError(authErrorMessage(err)); })
        .finally(() => { if (!cancelled) setSearchBusy(false); });
    }, term.length <= 2 ? 220 : 120);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [q]);

  const hits = useMemo(() => {
    const term = q.trim();
    if (!term) return [];
    if (remoteHits.length) return remoteHits.slice(0, 12);
    return searchUnits(units, term).slice(0, 12);
  }, [q, remoteHits, units]);

  const discountBps = Math.round(discountPct * 100);
  const extendedPrices = lines.map(lineExtendedPrice);
  const discountPreview = useMemo(
    () => applyTicketDiscount(extendedPrices, discountBps),
    [extendedPrices.join(','), discountBps],
  );
  const discounted = discountPreview.discounted;
  const discountCents = discountPreview.discountCents;
  const discountedTotal = sum(discounted);

  const signupPreviewCents = useMemo(() => {
    if (!customer || customer.first_purchase_discount_used) return 0;
    return Math.round((discountedTotal * rewards.rewardsSignupDiscountBps) / 10_000);
  }, [customer, discountedTotal, rewards.rewardsSignupDiscountBps]);

  const customerBalance = customer?.balance ?? 0;
  const redeemCents = Math.min(
    Math.round(redeemPoints * 10) * rewards.rewardsPointValueCents,
    Math.max(0, discountedTotal - signupPreviewCents),
  );
  const taxableSubtotal = Math.max(0, discountedTotal - signupPreviewCents - redeemCents);
  const earnPreview = Math.floor((taxableSubtotal * rewards.rewardsPointsPerDollar) / 100) / 10;
  const taxes = useMemo(() => {
    if (taxRateBps == null || !discounted.length) return discounted.map(() => 0);
    try {
      const adjusted =
        discountedTotal > 0
          ? discounted.map(p => Math.round((p * taxableSubtotal) / discountedTotal))
          : discounted;
      return allocateLineTaxes(adjusted, taxRateBps);
    } catch {
      return discounted.map(() => 0);
    }
  }, [discounted.join(','), taxRateBps, taxableSubtotal, discountedTotal]);

  const rawSubtotal = sum(extendedPrices);
  const tax = sum(taxes);
  const total = taxableSubtotal + tax;
  const cardFeeBps = rewards.cardFeeBps;
  const cardFeePreview = cardFeeCents(total, cardFeeBps);
  const itemCount = lines.reduce((a, l) => a + (l.qty || 1), 0);
  const cashTendered = cashDigits ? Number(cashDigits) : null;
  const change = cashTendered != null && Number.isFinite(cashTendered) ? cashTendered - total : null;
  const idle = phase === 'idle';

  function ticketLines(approvals: Record<string, string | null>) {
    return lines.map(l => ({
      sku: l.sku,
      priceCents: l.priceCents,
      qty: l.qty || 1,
      overrideReason: l.overrideReason.trim() || null,
      approvalId: approvals[l.sku] ?? l.approvalId,
    }));
  }

  function validateCart(): string | null {
    if (!lines.length) return 'Cart is empty.';
    if (taxRateBps == null) return 'Set your tax rate in Settings before checkout.';
    for (const line of lines) {
      if (line.askCents != null && line.priceCents !== line.askCents && !line.overrideReason.trim()) {
        return `SKU ${line.sku}: enter a reason when the price differs from ask.`;
      }
    }
    if (discountBps > rewards.clerkMaxDiscountBps && !discountApprovalId && !isAdmin) {
      return 'Discount above clerk max needs manager PIN.';
    }
    return null;
  }

  async function afterSale(
    summary: TicketSummary,
    changeCents: number | null,
    tenderedCents: number | null,
    saved?: ManualPayment,
  ) {
    await withdrawListingsAfterSale(summary.lines.map(l => l.sku));
    void refreshUnits().catch(() => undefined);
    const titles =
      saved?.titles ?? Object.fromEntries(lines.map(l => [l.sku, { title: l.title, condition: l.condition }]));
    setDone({
      summary,
      changeCents,
      cashTenderedCents: tenderedCents,
      customerEmail: customer?.email ?? null,
      receipt: ticketReceiptPayload(summary, {
        clerkName: soldByName || staffSession.displayName,
        storeName: rewards.storeDisplayName,
        changeCents,
        titles,
        cashTenderedCents: tenderedCents,
        legal: receiptLegal,
        headerMessage: receiptHeader,
        footerMessage: receiptFooter,
        qrHeader,
        qrCodeDataUrl,
      }),
    });
    setDoneMsg('');
    clear();
    setCashDigits('');
    setDiscountPct(0);
    setDiscountApprovalId(null);
    setCustomer(null);
    setRedeemPoints(0);
  }

  function handleSaleError(err: unknown) {
    if (err instanceof SellError && err.code === 'below_floor') {
      const m = err.message.match(/below_floor\s+(\d+)/i);
      setPinKind('below_floor');
      setPinSku(m?.[1] ?? lines[0]?.sku ?? null);
      setError(err.message);
    } else if (err instanceof SellError && (err.code === 'double_sell' || err.code === 'not_sellable')) {
      setLoud(err.message);
    } else {
      setError(authErrorMessage(err));
    }
  }

  async function runCash(approvals: Record<string, string | null>) {
    if (cashTendered == null || !Number.isFinite(cashTendered)) {
      setError('Enter cash received on the keypad.');
      return;
    }
    if (cashTendered < total) {
      setError('Cash received is less than the total.');
      return;
    }
    setBusy(true);
    setError('');
    setLoud('');
    try {
      const summary = await finalizeTicket({
        ticketId,
        paymentMethod: 'cash',
        amountTenderedCents: cashTendered,
        cashCents: total,
        cardCents: 0,
        discountBps,
        discountApprovalId,
        customerId: customer?.id ?? null,
        redeemPoints,
        note: note.trim() || null,
        soldByCode,
        lines: ticketLines(approvals),
      });
      setCashOpen(false);
      await afterSale(summary, change, cashTendered);
    } catch (err) {
      setPendingAction('cash');
      handleSaleError(err);
    } finally {
      setBusy(false);
      setPhase('idle');
    }
  }

  async function runCard(approvals: Record<string, string | null>, split?: { cashCents: number }) {
    setBusy(true);
    setPhase('quoting');
    setError('');
    setLoud('');
    try {
      const args = {
        ticketId,
        lines: ticketLines(approvals),
        paymentMethod: split ? 'split' : 'card',
        paymentId: `manual:${ticketId}`,
        discountBps,
        discountApprovalId,
        customerId: customer?.id ?? null,
        redeemPoints,
        cashCents: split?.cashCents ?? 0,
        note: note.trim() || null,
        soldByCode,
      };
      const quote = await quoteTicketTotals(args);
      if (quote.card_charge_cents <= 0) throw new Error('Cash covers the total. Use Cash instead.');
      const payment: ManualPayment = {
        quote,
        args: { ...args, cardCents: quote.card_base_cents },
        titles: Object.fromEntries(lines.map(l => [l.sku, { title: l.title, condition: l.condition }])),
      };
      localStorage.setItem(manualKey, JSON.stringify(payment));
      setManual(payment);
      setPhase('manual_card');
    } catch (err) {
      setPendingAction(split ? 'split' : 'card');
      handleSaleError(err);
      setPhase('idle');
    } finally {
      setBusy(false);
    }
  }

  async function completeManualCard() {
    if (!manual || confirming.current) return;
    confirming.current = true;
    setBusy(true);
    setPhase('finalizing');
    setError('');
    try {
      const summary = await finalizeTicket(manual.args);
      if (summary.total_cents !== manual.quote.total_cents) {
        window.alert(
          `Sale recorded for ${formatCentsTotal(summary.total_cents)}; the quoted total was ${formatCentsTotal(manual.quote.total_cents)}. Reconcile the difference in Square before continuing.`,
        );
      }
      await afterSale(summary, null, null, manual);
      localStorage.removeItem(manualKey);
      setManual(null);
      setPhase('idle');
    } catch (err) {
      if (err instanceof SellError && err.code === 'below_floor') handleSaleError(err);
      setError(
        `Sale not confirmed: ${authErrorMessage(err)}. Do not charge again. Retry to record this same ticket; if abandoning it, refund ${formatCentsTotal(manual.quote.card_charge_cents)} in the Square app.`,
      );
      setPhase('manual_card');
    } finally {
      confirming.current = false;
      setBusy(false);
    }
  }

  async function startPay(kind: PayKind, approvals: Record<string, string | null> = {}) {
    const err = validateCart();
    if (err) {
      if (err.includes('manager PIN')) {
        setPendingAction(kind);
        setPinKind('ticket_discount');
        setPinSku(lines[0]?.sku ?? '*');
      }
      setError(err);
      return;
    }
    if (kind === 'cash') {
      setCashDigits('');
      setError('');
      setCashOpen(true);
      return;
    }
    if (kind === 'card') await runCard(approvals);
    else setSplitOpen(true);
  }

  function closePin() {
    setPinKind(null);
    setPinSku(null);
    setPin('');
  }

  async function submitPin() {
    if (!pinKind || !pinSku || !pin) return;
    try {
      const id = await approveWithPin(pinKind, pinSku, pin, manual?.args.ticketId ?? ticketId);
      if (pinKind === 'ticket_discount') {
        setDiscountApprovalId(id);
        closePin();
        const action = pendingAction;
        setPendingAction(null);
        if (action) setError('Discount approved. Select the payment method again.');
        return;
      }
      closePin();
      updateLine(pinSku, { approvalId: id });
      if (manual) {
        const approved: ManualPayment = {
          ...manual,
          args: {
            ...manual.args,
            lines: manual.args.lines.map(line => (line.sku === pinSku ? { ...line, approvalId: id } : line)),
          },
        };
        localStorage.setItem(manualKey, JSON.stringify(approved));
        setManual(approved);
        setError('Approved. Click Card paid — complete sale again. Do not charge again.');
      } else {
        await startPay(pendingAction ?? 'cash', { [pinSku]: id });
      }
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  function addFromSearch(unit: RegisterUnit) {
    addUnit(unit);
    setQ('');
    setShowHits(false);
    setError('');
    searchRef.current?.focus();
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const term = q.trim();
      if (!term) return;
      if (hits[0]) {
        addFromSearch(hits[0]);
        return;
      }
      void queryAvailableUnits(term, 1)
        .then(rows => {
          if (rows[0]) addFromSearch(rows[0]);
          else setError(`No available unit for “${term}”.`);
        })
        .catch(err => setError(authErrorMessage(err)));
    } else if (e.key === 'Escape') {
      setShowHits(false);
    }
  }

  function pushDigit(d: string) {
    setCashDigits(prev => {
      if (d === 'C') return '';
      if (d === '⌫') return prev.slice(0, -1);
      if (prev.length >= 8) return prev;
      return prev + d;
    });
  }

  function applyDiscountDraft() {
    const pct = Number(discountDraft);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError('Enter a discount percent between 0 and 100.');
      return;
    }
    setDiscountPct(pct);
    setDiscountApprovalId(null);
    setDiscountOpen(false);
  }

  const splitCash = parseMoneyToCents(splitCashDraft);
  const splitBase = typeof splitCash === 'number' ? Math.max(0, total - splitCash) : 0;

  async function confirmSplit() {
    if (typeof splitCash !== 'number' || splitCash < 0) {
      setError('Enter a valid cash amount for split.');
      return;
    }
    if (splitCash >= total) {
      setError('Cash covers the full total — use Cash instead.');
      return;
    }
    setSplitOpen(false);
    await runCard({}, { cashCents: splitCash });
  }

  function newSale() {
    setDone(null);
    setError('');
    setLoud('');
    onNeedFullReload?.();
  }

  useEffect(() => {
    setPriceDrafts(prev => {
      const next: Record<string, string> = {};
      for (const line of lines) {
        next[line.sku] = prev[line.sku] ?? centsToInput(line.priceCents);
      }
      return next;
    });
  }, [lines]);

  function commitLinePrice(sku: string, draft: string) {
    const cleaned = draft === '.' ? '' : draft ? cleanMoney(draft) : '';
    setPriceDrafts(d => ({ ...d, [sku]: cleaned }));
    const cents = parseMoneyToCents(cleaned);
    if (cents == null || cents < 0) return;
    const line = lines.find(l => l.sku === sku);
    if (!line || line.priceCents === cents) return;
    const backToAsk = line.askCents != null && cents === line.askCents;
    updateLine(sku, {
      priceCents: cents,
      approvalId: null,
      overrideReason: backToAsk ? '' : (line.overrideReason.trim() || SALE_OVERRIDE),
    });
  }

  function addCustomPricedUnit(unit: RegisterUnit, priceCents: number) {
    const backToAsk = unit.askCents != null && priceCents === unit.askCents;
    addUnit(unit, {
      priceCents,
      overrideReason: backToAsk ? '' : SALE_OVERRIDE,
    });
    setPriceDrafts(d => ({ ...d, [unit.sku]: centsToInput(priceCents) }));
    setError('');
  }

  const sharedModals = (
    <>
      <RegisterSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={({
          taxRateBps: bps,
          storeDisplayName,
          receiptLegal: legal,
          headerMessage,
          footerMessage,
          qrHeader: qh,
          qrCodeDataUrl: qr,
        }) => {
          setTaxRateBps(bps);
          setRewards(r => ({ ...r, storeDisplayName }));
          setReceiptLegal(legal);
          setReceiptHeader(headerMessage);
          setReceiptFooter(footerMessage);
          setQrHeader(qh);
          setQrCodeDataUrl(qr);
        }}
      />

      {employeeOpen ? (
        <div className={`modal${app ? ' nr-sheet' : ''}`} role="dialog" aria-modal="true" aria-label="Employee ID">
          <div className={`card grid${app ? ' nr-sheet-card' : ''}`}>
            <h2>{app ? 'Cashier' : 'Employee ID'}</h2>
            <p className="muted">Enter your code before ringing up.</p>
            <label>
              Code
              <input
                autoFocus
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                value={employeeDraft}
                onChange={e => {
                  setEmployeeDraft(e.target.value.replace(/\D/g, '').slice(0, 8));
                  setEmployeeError('');
                }}
                onKeyDown={e => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const code = employeeDraft.trim();
                  const name = EMPLOYEE_CODES[code];
                  if (!name) {
                    setEmployeeError('Unknown employee ID.');
                    return;
                  }
                  setSoldByCode(code);
                  setSoldByName(name);
                  setEmployeeOpen(false);
                }}
              />
            </label>
            {employeeError ? <p className="error">{employeeError}</p> : null}
            <div className="row">
              <button type="button" className="secondary" onClick={() => setEmployeeOpen(false)}>Cancel</button>
              <button
                type="button"
                onClick={() => {
                  const code = employeeDraft.trim();
                  const name = EMPLOYEE_CODES[code];
                  if (!name) {
                    setEmployeeError('Unknown employee ID.');
                    return;
                  }
                  setSoldByCode(code);
                  setSoldByName(name);
                  setEmployeeOpen(false);
                }}
              >
                Set
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {customerOpen ? (
        <div className={`modal${app ? ' nr-sheet' : ''}`} role="dialog" aria-modal="true" aria-label="Customer lookup">
          <div className={`card grid${app ? ' nr-sheet-card' : ''}`}>
            <h2>Customer</h2>
            <CustomerAttach
              customer={customer}
              autoFocus
              disabled={!idle || cashOpen}
              onAttach={c => { setCustomer(c); setRedeemPoints(0); setError(''); setCustomerOpen(false); }}
              onClear={() => { setCustomer(null); setRedeemPoints(0); }}
            />
            <div className="row">
              <button type="button" className="secondary" onClick={() => setCustomerOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      ) : null}

      {discountOpen ? (
        <div className={`modal${app ? ' nr-sheet' : ''}`}>
          <div className={`card grid${app ? ' nr-sheet-card' : ''}`}>
            <h2>Ticket discount %</h2>
            <p className="muted">
              Clerk max {(rewards.clerkMaxDiscountBps / 100).toFixed(0)}%
              {isAdmin ? ' (managers may exceed)' : ' — above that needs manager PIN'}.
            </p>
            <label>Percent<input value={discountDraft} onChange={e => setDiscountDraft(e.target.value)} inputMode="decimal" autoFocus /></label>
            <div className="row">
              <button type="button" className="secondary" onClick={() => setDiscountOpen(false)}>Cancel</button>
              <button type="button" className="primary" onClick={applyDiscountDraft}>Apply</button>
            </div>
          </div>
        </div>
      ) : null}

      {noteOpen ? (
        <div className={`modal${app ? ' nr-sheet' : ''}`}>
          <div className={`card grid${app ? ' nr-sheet-card' : ''}`}>
            <h2>Order note</h2>
            <textarea rows={4} value={note} onChange={e => setNote(e.target.value)} autoFocus />
            <div className="row"><button type="button" onClick={() => setNoteOpen(false)}>Done</button></div>
          </div>
        </div>
      ) : null}

      {pinKind ? (
        <div className={`modal${app ? ' nr-sheet' : ''}`}>
          <div className={`card grid${app ? ' nr-sheet-card' : ''}`}>
            <h2>Manager PIN</h2>
            <p className="muted">
              {pinKind === 'ticket_discount' ? 'Discount above clerk maximum.' : `Below floor on SKU ${pinSku}.`}
            </p>
            <input type="password" value={pin} onChange={e => setPin(e.target.value)} autoFocus />
            {error ? <p className="error">{error}</p> : null}
            <div className="row">
              <button type="button" className="secondary" onClick={() => { closePin(); setPendingAction(null); }}>Cancel</button>
              <button type="button" className="primary" onClick={() => void submitPin()}>Approve</button>
            </div>
          </div>
        </div>
      ) : null}

      <NativePaySheets
        app={app}
        cashOpen={cashOpen}
        total={total}
        cashDigits={cashDigits}
        setCashDigits={setCashDigits}
        cashTendered={cashTendered}
        change={change}
        pushDigit={pushDigit}
        busy={busy}
        error={error}
        setCashOpen={setCashOpen}
        setError={setError}
        runCash={() => void runCash({})}
        manual={manual}
        completeManualCard={() => void completeManualCard()}
        dismissManual={() => {
          localStorage.removeItem(manualKey);
          setManual(null);
          setPhase('idle');
          setError('');
        }}
        splitOpen={splitOpen}
        setSplitOpen={setSplitOpen}
        splitCashDraft={splitCashDraft}
        setSplitCashDraft={setSplitCashDraft}
        splitCash={splitCash}
        splitBase={splitBase}
        cardFeeBps={cardFeeBps}
        confirmSplit={() => void confirmSplit()}
      />
    </>
  );

  if (done) {
    if (app) {
      return (
        <NativeRegisterDone
          done={done}
          doneMsg={doneMsg}
          setDoneMsg={setDoneMsg}
          newSale={newSale}
          customerEmail={done.customerEmail}
        />
      );
    }
    const { summary, changeCents, receipt } = done;
    return (
      <div className="admin-register">
        <header>
          <div>
            <div className="eyebrow">REGISTER</div>
            <h1>Sale complete</h1>
            <p>Ticket {summary.ticket_id.slice(0, 8)}…</p>
          </div>
        </header>
        <section className="panel register-done">
          {summary.lines.map(l => (
            <div className="summary-row" key={l.sale_id}>
              <span>
                <strong>{l.receipt_no} · {l.sku}</strong>
                <div className="muted">{receipt.lines.find(x => x.sku === l.sku)?.title || 'Item'}</div>
              </span>
              <span>{formatCentsTotal(l.price_cents + l.tax_cents)}</span>
            </div>
          ))}
          <div className="register-done-totals">
            <div className="summary-row"><span>Subtotal</span><span>{formatCentsTotal(summary.subtotal_cents)}</span></div>
            {summary.discount_cents ? (
              <div className="summary-row"><span>Discount</span><span>−{formatCentsTotal(summary.discount_cents)}</span></div>
            ) : null}
            {summary.signup_discount_cents ? (
              <div className="summary-row muted"><span>New-customer discount</span><span>−{formatCentsTotal(summary.signup_discount_cents)}</span></div>
            ) : null}
            <div className="summary-row"><span>Tax</span><span>{formatCentsTotal(summary.tax_cents)}</span></div>
            {summary.card_fee_cents ? (
              <div className="summary-row"><span>Card fee</span><span>{formatCentsTotal(summary.card_fee_cents)}</span></div>
            ) : null}
            <div className="summary-row checkout-total"><span>Total</span><span>{formatCentsTotal(summary.total_cents)}</span></div>
            {summary.payment_method === 'split' ? (
              <div className="summary-row muted">
                <span>Tender</span>
                <span>cash {formatCentsTotal(summary.cash_cents ?? 0)} · card {formatCentsTotal(summary.card_cents ?? 0)}</span>
              </div>
            ) : null}
            {changeCents != null ? (
              <div className="summary-row"><span>Change</span><strong>{formatCentsTotal(changeCents)}</strong></div>
            ) : null}
            {summary.points_earned ? (
              <div className="summary-row muted">
                <span>Points earned</span>
                <span>{formatPoints(summary.points_earned)}{summary.points_balance != null ? ` · balance ${formatPoints(summary.points_balance)}` : ''}</span>
              </div>
            ) : null}
          </div>
          {doneMsg ? <p className="muted">{doneMsg}</p> : null}
          <div className="actions">
            <button
              type="button"
              onClick={() => setDoneMsg(printReceiptHtml(receiptHtml(receipt)) ? 'Print dialog opened.' : 'Could not open print dialog.')}
            >
              Print receipt
            </button>
            <button type="button" className="secondary" onClick={() => downloadReceiptText(receipt)}>Save as text</button>
            <button type="button" className="secondary" onClick={newSale}>New sale</button>
          </div>
        </section>
      </div>
    );
  }

  if (app) {
    return (
      <NativeRegisterCart
        lines={lines}
        note={note}
        setNote={setNote}
        ticketId={ticketId}
        q={q}
        setQ={setQ}
        showHits={showHits}
        setShowHits={setShowHits}
        hits={hits}
        searchBusy={searchBusy}
        searchRef={searchRef}
        onSearchKey={onSearchKey}
        addFromSearch={addFromSearch}
        idle={idle}
        busy={busy}
        cashOpen={cashOpen}
        error={error}
        loud={loud}
        soldByName={soldByName}
        customer={customer}
        taxRateBps={taxRateBps}
        itemCount={itemCount}
        rawSubtotal={rawSubtotal}
        discountCents={discountCents}
        discountPct={discountPct}
        tax={tax}
        total={total}
        cardFeePreview={cardFeePreview}
        cardFeeBps={cardFeeBps}
        phase={phase}
        priceDrafts={priceDrafts}
        setPriceDrafts={setPriceDrafts}
        commitLinePrice={commitLinePrice}
        updateLine={updateLine}
        setQty={setQty}
        removeSku={removeSku}
        clear={clear}
        startPay={kind => void startPay(kind)}
        setDiscountOpen={setDiscountOpen}
        setDiscountDraft={setDiscountDraft}
        setNoteOpen={setNoteOpen}
        setCustomerOpen={setCustomerOpen}
        setEmployeeOpen={setEmployeeOpen}
        setEmployeeDraft={setEmployeeDraft}
        setEmployeeError={setEmployeeError}
        onCustomUnit={addCustomPricedUnit}
        queryUnit={term => queryAvailableUnits(term, 8)}
      >
        {sharedModals}
      </NativeRegisterCart>
    );
  }

  return (
    <div className="admin-register compact">
      <header className="register-top">
        <div>
          <h1>Register</h1>
          <p>Scan items, then cash or card.</p>
        </div>
        <div className="register-center-actions">
          {soldByName ? (
            <div className="employee-chip">
              <span>
                <strong>{soldByName}</strong>
                <small className="muted">Employee</small>
              </span>
              <button
                type="button"
                className="secondary"
                disabled={!idle || cashOpen}
                onClick={() => { setSoldByCode(null); setSoldByName(null); }}
              >
                Clear
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="employee-id-btn"
              disabled={!idle || cashOpen}
              onClick={() => { setEmployeeDraft(''); setEmployeeError(''); setEmployeeOpen(true); }}
            >
              Employee ID
            </button>
          )}
          {customer ? (
            <div className="customer-chip">
              <span>
                <strong>{customer.name || 'Customer'}</strong>
                <small className="muted">{customer.phone} · {formatPoints(customer.balance)} pts</small>
              </span>
              <button type="button" className="secondary" disabled={!idle || cashOpen} onClick={() => setCustomerOpen(true)}>Edit</button>
              <button type="button" className="secondary" disabled={!idle || cashOpen} onClick={() => { setCustomer(null); setRedeemPoints(0); }}>Clear</button>
            </div>
          ) : (
            <button
              type="button"
              className="customer-lookup-btn"
              disabled={!idle || cashOpen}
              onClick={() => setCustomerOpen(true)}
            >
              Customer lookup
            </button>
          )}
        </div>
        <div className="register-top-actions">
          <button
            type="button"
            className="secondary register-gear"
            disabled={!idle || cashOpen}
            aria-label="Register settings"
            title="Register settings"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
          <button type="button" className="secondary" disabled={!idle} onClick={() => setNoteOpen(true)}>Note{note ? ' ✓' : ''}</button>
          <button type="button" className="secondary" disabled={!idle} onClick={() => void refreshUnits().catch(err => setError(authErrorMessage(err)))}>Refresh</button>
          <button type="button" className="danger" disabled={!lines.length || !idle} onClick={() => { if (window.confirm('Clear the cart?')) clear(); }}>Clear</button>
        </div>
      </header>

      <div className="cart-panel">
        <div className="register-search-wrap">
          <input
            ref={searchRef}
            className="search"
            placeholder="Scan or search SKU, title…"
            value={q}
            onChange={e => {
              setQ(e.target.value);
              setShowHits(Boolean(e.target.value.trim()));
            }}
            onFocus={() => q.trim() && setShowHits(true)}
            onKeyDown={onSearchKey}
            autoFocus={!isAndroidStoreDevice() && (!isCoarse || isKioskShell())}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            inputMode={scannerInputMode() || 'search'}
            disabled={!idle || cashOpen}
          />
          {showHits && (hits.length || searchBusy) ? (
            <div className="search-results">
              {searchBusy && !hits.length ? <div className="search-hit muted">Searching…</div> : null}
              {hits.map(u => (
                <button key={u.sku} type="button" className="search-hit" onClick={() => addFromSearch(u)}>
                  <span>
                    <strong>{u.sku}</strong>
                    <div>{[u.brand, u.model].filter(Boolean).join(' ') || u.title}</div>
                  </span>
                  <span className="price">{formatCents(u.askCents) || '—'}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="cart-scroll">
        <table className="cart-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Total</th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map(line => {
              const draft = priceDrafts[line.sku] ?? centsToInput(line.priceCents);
              const draftCents = parseMoneyToCents(draft);
              const priceChanged = line.askCents != null && draftCents != null && draftCents !== line.askCents;
              return (
              <tr key={line.sku}>
                <td>
                  <div className="cart-item">
                    <strong>{line.title}</strong>
                    <span className="muted">{line.sku}{line.condition ? ` · ${line.condition}` : ''}{line.askCents != null ? ` · ask ${formatCents(line.askCents)}` : ''}</span>
                    {priceChanged ? (
                      <label className="cart-override">
                        Override reason
                        <input
                          type="text"
                          value={line.overrideReason}
                          disabled={!idle || cashOpen}
                          placeholder="Required when price ≠ ask"
                          onChange={e => updateLine(line.sku, { overrideReason: e.target.value })}
                        />
                      </label>
                    ) : null}
                  </div>
                </td>
                <td>
                  {line.qtyOnHand > 1 ? (
                    <div className="qty-stepper">
                      <button type="button" className="secondary" disabled={!idle || cashOpen || line.qty <= 1} onClick={() => setQty(line.sku, line.qty - 1)}>−</button>
                      <span>{line.qty}</span>
                      <button type="button" className="secondary" disabled={!idle || cashOpen || line.qty >= line.qtyOnHand} onClick={() => setQty(line.sku, line.qty + 1)}>+</button>
                    </div>
                  ) : '1'}
                </td>
                <td>
                  <input
                    className="cart-price"
                    type="text"
                    inputMode="decimal"
                    aria-label={`Price for ${line.sku}`}
                    disabled={!idle || cashOpen}
                    value={draft}
                    onChange={e => {
                      if (!moneyEntry.test(e.target.value)) return;
                      setPriceDrafts(d => ({ ...d, [line.sku]: e.target.value }));
                    }}
                    onBlur={() => commitLinePrice(line.sku, draft)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </td>
                <td>{formatCentsTotal(lineExtendedPrice({ ...line, priceCents: draftCents ?? line.priceCents }))}</td>
                <td>
                  <button type="button" className="secondary" disabled={!idle || cashOpen} onClick={() => removeSku(line.sku)} aria-label="Remove">×</button>
                </td>
              </tr>
              );
            })}
            {!lines.length ? (
              <tr><td colSpan={5}><p className="muted register-empty">Scan or search to add an item.</p></td></tr>
            ) : null}
          </tbody>
        </table>
        </div>
      </div>

      <div className="checkout-bar">
        {loud ? <div className="incident">{loud}</div> : null}
        {error && !cashOpen ? <p className="error">{error}</p> : null}
        <div className="checkout-summary">
          <div className="summary-row">
            <span>Subtotal ({itemCount})</span>
            <span>{formatCentsTotal(rawSubtotal)}</span>
          </div>
          {(discountCents > 0 || discountPct > 0) && (
            <div className="summary-row">
              <span>
                Discount
                <button type="button" className="icon-btn" title="Edit discount" disabled={!idle || cashOpen} onClick={() => { setDiscountDraft(String(discountPct || '')); setDiscountOpen(true); }}>✎</button>
              </span>
              <span>{discountCents ? `−${formatCentsTotal(discountCents)}` : formatCentsTotal(0)}</span>
            </div>
          )}
          <div className="summary-row">
            <span>Tax {taxRateBps != null ? `(${(taxRateBps / 100).toFixed(2)}%)` : ''}</span>
            <span>{formatCentsTotal(tax)}</span>
          </div>
          {cardFeeBps > 0 && lines.length ? (
            <div className="summary-row muted">
              <span>Card total (+{(cardFeeBps / 100).toFixed(2)}%)</span>
              <span>{formatCentsTotal(total + cardFeePreview)}</span>
            </div>
          ) : null}
          <div className="summary-row checkout-total"><span>TOTAL</span><span>{formatCentsTotal(total)}</span></div>
        </div>

        {!idle ? (
          <p className="muted">{phase === 'quoting' ? 'Getting exact total…' : 'Confirm payment…'}</p>
        ) : (
          <div className="pay-row">
            <button type="button" className="cash" disabled={busy || !lines.length || cashOpen} onClick={() => void startPay('cash')}>CASH</button>
            <button type="button" className="card" disabled={busy || !lines.length || cashOpen} onClick={() => void startPay('card')}>CARD</button>
            <button type="button" className="secondary" disabled={busy || !lines.length || cashOpen} onClick={() => void startPay('split')}>Split</button>
            <button type="button" className="secondary" disabled={!idle || cashOpen} onClick={() => { setDiscountDraft(String(discountPct || '')); setDiscountOpen(true); }}>% Off</button>
          </div>
        )}

        {customer && customerBalance > 0 ? (
          <div className="row">
            <label style={{ flex: 1 }}>
              Apply credit (points)
              <input
                type="number"
                min={0}
                step={0.1}
                max={customerBalance}
                value={redeemPoints || ''}
                disabled={!idle || cashOpen}
                onChange={e => setRedeemPoints(Math.round(Math.max(0, Math.min(customerBalance, Number(e.target.value) || 0)) * 10) / 10)}
              />
            </label>
            {lines.length ? <p className="muted">+{formatPoints(earnPreview)} pts this sale</p> : null}
          </div>
        ) : customer && lines.length ? (
          <p className="muted">Points this sale +{formatPoints(earnPreview)}</p>
        ) : null}
      </div>

      {cashOpen ? (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Cash tendered">
          <div className="card grid cash-sheet">
            <h2>Cash</h2>
            <div className="summary-row checkout-total"><span>Due</span><span>{formatCentsTotal(total)}</span></div>
            <div className="summary-row">
              <span>Tendered</span>
              <span className="price">{cashTendered != null ? formatCentsTotal(cashTendered) : '$0.00'}</span>
            </div>
            {change != null && change >= 0 ? (
              <div className="summary-row change-due"><span>Change</span><strong>{formatCentsTotal(change)}</strong></div>
            ) : null}
            {error ? <p className="error">{error}</p> : null}
            <div className="numpad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(d => (
                <button key={d} type="button" className="secondary" disabled={busy} onClick={() => pushDigit(d)}>{d}</button>
              ))}
            </div>
            <p className="muted">Enter cents (2000 = $20.00).</p>
            <div className="row">
              <button type="button" className="secondary" disabled={busy} onClick={() => { setCashOpen(false); setCashDigits(''); setError(''); }}>Back</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setCashDigits(String(total))}>Exact</button>
              <button
                type="button"
                className="cash"
                disabled={busy || cashTendered == null || cashTendered < total}
                onClick={() => void runCash({})}
              >
                {busy ? 'Recording…' : 'Complete sale'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {manual ? (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Manual card payment">
          <div className="card grid">
            <h2>Charge in Square</h2>
            <strong className="register-charge">{formatCentsTotal(manual.quote.card_charge_cents)}</strong>
            <p>Tax {formatCentsTotal(manual.quote.tax_cents)} · Card fee {formatCentsTotal(manual.quote.card_fee_cents)} (included)</p>
            {manual.args.paymentMethod === 'split' ? <p>Collect {formatCentsTotal(manual.args.cashCents ?? 0)} cash in the drawer.</p> : null}
            <p>Charge the exact amount above in Square. Confirm only after Square says paid.</p>
            {error ? <p className="error">{error}</p> : null}
            <button type="button" className="primary" disabled={busy} onClick={() => void completeManualCard()}>
              {busy ? 'Recording sale…' : 'Card paid — complete sale'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Leave this payment? If already charged, refund it in Square before starting another sale.')) {
                  localStorage.removeItem(manualKey);
                  setManual(null);
                  setPhase('idle');
                  setError('');
                }
              }}
            >
              Back
            </button>
          </div>
        </div>
      ) : null}

      {splitOpen ? (
        <div className="modal">
          <div className="card grid">
            <h2>Split payment</h2>
            <p className="muted">Total {formatCentsTotal(total)}. Card charges the remainder after cash.</p>
            <label>
              Cash amount
              <input value={splitCashDraft} onChange={e => setSplitCashDraft(e.target.value)} inputMode="decimal" placeholder="0.00" autoFocus />
            </label>
            {typeof splitCash === 'number' ? (
              <>
                <p className="muted">
                  Card portion {formatCentsTotal(splitBase)}
                  {cardFeeBps > 0 ? ` + card fee ${formatCentsTotal(cardFeeCents(splitBase, cardFeeBps))}` : ''}
                </p>
                <p>Card charge <strong>{formatCentsTotal(splitBase + cardFeeCents(splitBase, cardFeeBps))}</strong></p>
              </>
            ) : null}
            {error ? <p className="error">{error}</p> : null}
            <div className="row">
              <button type="button" className="secondary" onClick={() => setSplitOpen(false)}>Cancel</button>
              <button type="button" className="primary" onClick={() => void confirmSplit()}>Continue to card amount</button>
            </div>
          </div>
        </div>
      ) : null}

      {sharedModals}
    </div>
  );
}

type Props = { staffSession: StaffSession; onNeedFullReload?: () => void; variant?: 'desktop' | 'app' };

class RegisterBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(err: unknown) {
    return { error: errText(err) };
  }
  render() {
    if (this.state.error) {
      return (
        <section className="panel">
          <h2>Register failed to load</h2>
          <p className="error">{this.state.error}</p>
          <button type="button" onClick={() => location.reload()}>Reload</button>
        </section>
      );
    }
    return this.props.children;
  }
}

export function RegisterPage(props: Props) {
  return (
    <RegisterBoundary>
      <CartProvider>
        <RegisterInner {...props} />
      </CartProvider>
    </RegisterBoundary>
  );
}
