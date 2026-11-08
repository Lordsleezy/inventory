import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fillCdtfaPdf } from './cdtfaPdf';
import { CdtfaPaper, type PaperLine, type PaperSale, type PaperSigner } from './CdtfaPaper';
import { dueOn, filingBounds, periodChoices, periodLabel, resolveCdtfaDollars, type CdtfaFrequency } from './cdtfaResolve';

type Check = { id: string; ok: boolean; detail: string; sales?: PaperSale[] };
type FloorLine = { id: string; label: string; dollars: number; note: string; sales: PaperSale[] };
type Doc = {
  frequency: CdtfaFrequency;
  period_start: string; period_end: string; due_on: string; due_note: string;
  open: boolean; locked: boolean; ready: boolean; place: string;
  lines: FloorLine[]; checks: Check[];
  schedule_a2: { note: string };
  collected_cents?: number;
  months?: { locked: boolean }[];
};

type Props = { client: SupabaseClient; money: (cents: number) => string; monthStart: string };

const FREQUENCIES: [CdtfaFrequency, string][] = [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']];
const SIGNER_FIELDS = ['name', 'title', 'date', 'email', 'phone', 'account'] as const;

function emptySigner(): PaperSigner {
  return { name: '', title: '', date: '', email: '', phone: '', account: '' };
}

export function CdtfaReturn({ client, money, monthStart }: Props) {
  const [frequency, setFrequency] = useState<CdtfaFrequency>('quarterly');
  const [periodStart, setPeriodStart] = useState('');
  const [doc, setDoc] = useState<Doc | null>(null);
  const [edits, setEdits] = useState<Record<string, number | undefined>>({});
  const [signer, setSigner] = useState<PaperSigner>(emptySigner());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const choices = periodChoices(frequency, today);

  const loadPeriod = useCallback(async (start: string, end: string) => {
    const [result, saved] = await Promise.all([
      client.rpc('portal_cdtfa_return', { p_start: start, p_end: end }),
      client.rpc('portal_cdtfa_edits', { p_start: start, p_end: end }),
    ]);
    if (result.error) { setError(result.error.message); setDoc(null); return; }
    if (saved.error) { setError(saved.error.message); return; }
    const next = result.data as Doc;
    const raw = (saved.data || {}) as Record<string, { dollars: number | null; text: string | null }>;
    const amounts: Record<string, number | undefined> = {};
    const person = emptySigner();
    for (const [field, value] of Object.entries(raw)) {
      if (SIGNER_FIELDS.includes(field as typeof SIGNER_FIELDS[number])) person[field as keyof PaperSigner] = value.text || '';
      else if (value.dollars != null) amounts[field] = value.dollars;
    }
    setDoc(next);
    setEdits(amounts);
    setSigner(person);
    setPeriodStart(start);
  }, [client]);

  const load = useCallback(async () => {
    setError('');
    const filing = await client.rpc('portal_cdtfa_filing');
    if (filing.error) { setError(filing.error.message); return; }
    const next = (filing.data as CdtfaFrequency) || 'quarterly';
    setFrequency(next);
    const period = filingBounds(monthStart, next);
    await loadPeriod(period.start, period.end);
  }, [client, loadPeriod, monthStart]);

  useEffect(() => { void load(); }, [load]);

  const resolved = useMemo(() => {
    if (!doc) return [];
    const collected = Math.round(Number(doc.collected_cents || 0) / 100);
    return resolveCdtfaDollars(doc.lines, edits, collected);
  }, [doc, edits]);

  const lines: PaperLine[] = useMemo(() => {
    if (!doc) return [];
    const byId = new Map(resolved.map((row) => [row.id, row]));
    return doc.lines.map((line) => {
      const row = byId.get(line.id);
      return { ...line, dollars: row?.dollars ?? line.dollars, floor: line.dollars, edited: !!row?.edited, sales: line.sales || [] };
    });
  }, [doc, resolved]);

  const editsLocked = !!doc && ((doc.months || []).some((month) => month.locked) || doc.locked);
  const label = doc ? periodLabel(doc.period_start, doc.period_end, frequency, doc.due_on) : '';

  async function chooseFrequency(next: CdtfaFrequency) {
    setBusy(true); setError('');
    const saved = await client.rpc('portal_set_cdtfa_filing', { p_frequency: next });
    setBusy(false);
    if (saved.error) { setError(saved.error.message); return; }
    setFrequency(next);
    const period = filingBounds(monthStart, next);
    await loadPeriod(period.start, period.end);
  }

  async function save(field: string, dollars: number | null, text: string | null) {
    if (!doc || editsLocked) return;
    setError('');
    const result = await client.rpc('portal_set_cdtfa_edit', {
      p_start: doc.period_start, p_end: doc.period_end, p_field: field, p_dollars: dollars, p_text: text,
    });
    if (result.error) { setError(result.error.message); return; }
    if (SIGNER_FIELDS.includes(field as typeof SIGNER_FIELDS[number])) {
      setSigner((prev) => ({ ...prev, [field]: text || '' }));
      return;
    }
    setEdits((prev) => {
      const next = { ...prev };
      if (dollars == null) delete next[field];
      else next[field] = dollars;
      return next;
    });
  }

  function printSheet() {
    document.body.classList.add('cdtfa-printing');
    window.print();
    window.setTimeout(() => document.body.classList.remove('cdtfa-printing'), 500);
  }

  async function downloadPdf() {
    if (!doc) return;
    setBusy(true); setError('');
    try {
      const bytes = await fillCdtfaPdf({
        period_start: doc.period_start,
        period_end: doc.period_end,
        due_on: doc.due_on,
        lines: lines.map((line) => ({ id: line.id, dollars: line.dollars })),
        signer,
      });
      const blob = new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `CDTFA-401-A-${doc.period_start}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not fill the CDTFA form.');
    } finally { setBusy(false); }
  }

  return (
    <section className="cdtfa-sheet">
      <div className="cdtfa-toolbar">
        <label>Filing period
          <select aria-label="Filing period" value={periodStart} disabled={!choices.length || busy} onChange={(e) => {
            const choice = choices.find((row) => row.start === e.target.value);
            if (choice) void loadPeriod(choice.start, choice.end);
          }}>
            {choices.map((choice) => <option key={choice.start} value={choice.start}>{choice.label}</option>)}
          </select>
        </label>
        <div className="cdtfa-freq" role="group" aria-label="Filing frequency">
          {FREQUENCIES.map(([id, name]) => (
            <button key={id} type="button" className={frequency === id ? 'on' : ''} disabled={busy} onClick={() => void chooseFrequency(id)}>{name}</button>
          ))}
        </div>
      </div>
      {error && <p className="cdtfa-bad" role="alert">{error}</p>}
      {doc && (
        <>
          <p className={doc.ready ? 'cdtfa-status' : 'cdtfa-status cdtfa-bad'}>
            {doc.ready ? 'Ready to review' : doc.open ? 'Not ready — this period is still open' : 'Not ready'}
          </p>
          <ul className="cdtfa-checks">
            {doc.checks.map((check) => (
              <li key={check.id} className={check.ok ? '' : 'cdtfa-bad'}>
                {check.detail}
                {(check.sales || []).length > 0 && !check.ok && (
                  <ul className="cdtfa-sales">
                    {check.sales!.map((sale, index) => (
                      <li key={`${sale.id}-${index}`}>
                        <span>{sale.title}<small>{sale.sold_on} · SKU {sale.sku} · {sale.channel}{sale.ship ? ` · ${sale.ship}` : ''}{sale.bucket === 'missing_state' ? ' · ship-to state missing' : ''}</small></span>
                        <b>{money(sale.measure_cents)}</b>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <CdtfaPaper
            lines={lines}
            signer={signer}
            open={doc.open}
            locked={editsLocked}
            periodLabel={label}
            periodStart={doc.period_start}
            periodEnd={doc.period_end}
            dueOn={doc.due_on || dueOn(doc.period_end)}
            scheduleNote={doc.schedule_a2?.note || doc.place}
            districtMeasure={edits.A4 ?? 0}
            districtMeasureEdited={edits.A4 != null}
            money={money}
            readOnly={editsLocked}
            onDollars={(id, dollars) => {
              const floor = doc.lines.find((line) => line.id === id)?.dollars;
              void save(id, dollars != null && dollars === floor ? null : dollars, null);
            }}
            onSigner={(field, value) => void save(field, null, value)}
          />
          <p className="cdtfa-note">{doc.due_note}</p>
          <div className="cdtfa-actions">
            <button type="button" onClick={printSheet}>Print</button>
            <button type="button" onClick={() => void downloadPdf()} disabled={busy}>Download filled CDTFA-401-A</button>
          </div>
        </>
      )}
    </section>
  );
}
