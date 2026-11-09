import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fillCdtfaPdf, loadCdtfaTemplate, paperToCdtfaDoc } from './cdtfaPdf';
import { selectCdtfaPages } from './cdtfaPages';
import { buildCdtfaWorksheet } from './cdtfaWorksheet';
import { cdtfaPageTexts, officialCdtfaPdf, printCdtfaPages } from './cdtfaTrimClient';
import { CdtfaPaper, type PaperLine, type PaperSale, type PaperSigner } from './CdtfaPaper';
import { dueOn, periodChoices, periodLabel, resolveCdtfaDollars, type CdtfaFrequency } from './cdtfaResolve';
import { filingOption, formKind, parseFiling, recordsStamp, spanFrequency } from './booksSpan';
import { loadCdtfaRoundingNote } from './cdtfaLoad';

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

type Props = {
  client: SupabaseClient;
  money: (cents: number) => string;
  periodStart: string;
  periodEnd: string;
  onPeriod: (start: string) => void;
  onFiling?: (frequency: CdtfaFrequency | null) => void;
  layout?: 'desk' | 'phone';
};

const FREQUENCIES: [CdtfaFrequency, string][] = [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']];
const SIGNER_FIELDS = ['name', 'title', 'date', 'email', 'phone', 'account'] as const;

function emptySigner(): PaperSigner {
  return { name: '', title: '', date: '', email: '', phone: '', account: '' };
}

type Filing = { period_start: string; period_end: string; filed_on: string; paid_how: string; confirmation: string };

export function CdtfaReturn({ client, money, periodStart, periodEnd, onPeriod, onFiling, layout = 'desk' }: Props) {
  const [frequency, setFrequency] = useState<CdtfaFrequency | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [edits, setEdits] = useState<Record<string, number | undefined>>({});
  const [signer, setSigner] = useState<PaperSigner>(emptySigner());
  const [roundGap, setRoundGap] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [filings, setFilings] = useState<Filing[]>([]);
  const [fileOn, setFileOn] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }));
  const [fileTouched, setFileTouched] = useState(false);
  const [paidHow, setPaidHow] = useState('check');
  const [confirmation, setConfirmation] = useState('');
  const [preparer, setPreparer] = useState('');
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pageWarning, setPageWarning] = useState<string | null>(null);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const kind = formKind(periodStart, periodEnd);
  const choices = periodChoices(spanFrequency(kind), today);

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
    let preparerName = '';
    for (const [field, value] of Object.entries(raw)) {
      if (SIGNER_FIELDS.includes(field as typeof SIGNER_FIELDS[number])) person[field as keyof PaperSigner] = value.text || '';
      else if (field === 'preparer') preparerName = value.text || '';
      else if (value.dollars != null) amounts[field] = value.dollars;
    }
    setDoc(next);
    setEdits(amounts);
    setSigner(person);
    setPreparer(preparerName);
    const gap = await loadCdtfaRoundingNote(client, next.lines, start, end);
    setRoundGap(gap);
  }, [client]);

  const load = useCallback(async () => {
    setError('');
    const filing = await client.rpc('portal_cdtfa_filing');
    if (filing.error) { setError(filing.error.message); return; }
    const next = parseFiling(filing.data);
    setFrequency(next);
    onFiling?.(next);
    const filed = await client.rpc('portal_cdtfa_filings');
    if (!filed.error && Array.isArray(filed.data)) setFilings(filed.data as Filing[]);
    await loadPeriod(periodStart, periodEnd);
  }, [client, loadPeriod, onFiling, periodStart, periodEnd]);

  useEffect(() => { void load(); }, [load]);

  const marked = filings.find((row) => row.period_start === doc?.period_start && row.period_end === doc?.period_end);
  const late = !!doc && fileOn > (doc.due_on || dueOn(doc.period_end));
  const resolved = useMemo(() => {
    if (!doc) return [];
    const collected = Math.round(Number(doc.collected_cents || 0) / 100);
    return resolveCdtfaDollars(doc.lines, edits, collected, late);
  }, [doc, edits, late]);

  const lines: PaperLine[] = useMemo(() => {
    if (!doc) return [];
    const byId = new Map(resolved.map((row) => [row.id, row]));
    return doc.lines.map((line) => {
      const row = byId.get(line.id);
      const interestBlank = line.id === '25' && late && edits['25'] == null;
      const note = line.id === '24' && late
        ? `${line.note} Filing date ${fileOn} is after the due date, so this is 10 percent of line 23, rounded to the nearest dollar.`
        : line.id === '25' && late
          ? 'Left blank. Use CDTFA’s interest calculation tool. Floor does not guess the rate, and this total does not include interest until you type it.'
          : line.note;
      return { ...line, dollars: row?.dollars ?? line.dollars, floor: line.dollars, edited: !!row?.edited, sales: line.sales || [], note, blank: interestBlank };
    });
  }, [doc, resolved, late, fileOn, edits]);

  const editsLocked = !!doc?.locked;
  const districtTax = lines.find((line) => line.id === '16')?.dollars ?? 0;
  useEffect(() => {
    if (fileTouched) return;
    if (marked?.filed_on) setFileOn(marked.filed_on);
  }, [marked?.filed_on, fileTouched]);
  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const texts = await cdtfaPageTexts(new Uint8Array(await loadCdtfaTemplate()));
        const plan = selectCdtfaPages(texts, districtTax);
        if (cancel) return;
        setPageCount(plan.warning ? texts.length : plan.keep.length);
        setPageWarning(plan.warning);
      } catch { /* the download button reports a missing template */ }
    })();
    return () => { cancel = true; };
  }, [districtTax]);
  const label = doc ? periodLabel(doc.period_start, doc.period_end, spanFrequency(kind), doc.due_on) : '';
  const recordsNote = recordsStamp(kind, frequency);
  const option = filingOption(kind, frequency);

  async function chooseFrequency(next: CdtfaFrequency) {
    setBusy(true); setError('');
    const saved = await client.rpc('portal_set_cdtfa_filing', { p_frequency: next });
    setBusy(false);
    if (saved.error) { setError(saved.error.message); return; }
    setFrequency(next);
    onFiling?.(next);
  }

  async function save(field: string, dollars: number | null, text: string | null) {
    if (!doc) return;
    if (editsLocked && field !== '25' && field !== 'preparer') return;
    setError('');
    if (!editsLocked) {
      const result = await client.rpc('portal_set_cdtfa_edit', {
        p_start: doc.period_start, p_end: doc.period_end, p_field: field, p_dollars: dollars, p_text: text,
      });
      if (result.error) { setError(result.error.message); return; }
    }
    if (field === 'preparer') { setPreparer(text || ''); return; }
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

  function filledDoc() {
    if (!doc) return null;
    return paperToCdtfaDoc({
      periodStart: doc.period_start,
      periodEnd: doc.period_end,
      dueOn: doc.due_on,
      open: doc.open,
      recordsNote,
      optionTitle: option?.title,
      optionHint: option?.hint,
      districtMeasure: edits.A4 ?? 0,
      lines,
      signer,
      omitInterest: late && edits['25'] == null,
      preparer,
    });
  }

  async function builtReturn(full: boolean) {
    const model = filledDoc();
    if (!model) throw new Error('The return is not loaded.');
    const filled = await fillCdtfaPdf(model);
    if (full) return { bytes: filled, pageCount: pageCount ?? 0, warning: null as string | null };
    const district = lines.find((line) => line.id === '16')?.dollars ?? 0;
    return officialCdtfaPdf(filled, district);
  }

  function saveFile(bytes: Uint8Array, name: string) {
    const blob = new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadPdf(full = false) {
    if (!doc) return;
    setBusy(true); setError('');
    try {
      const ready = await builtReturn(full);
      if (!full) {
        setPageCount(ready.pageCount);
        setPageWarning(ready.warning);
      }
      saveFile(ready.bytes, `CDTFA-401-A_${doc.period_start.slice(0, 7)}_Open-Box-Industries.pdf`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not fill the CDTFA form.');
    } finally { setBusy(false); }
  }

  async function printReturn() {
    if (!doc) return;
    setBusy(true); setError('');
    try {
      const ready = await builtReturn(false);
      setPageCount(ready.pageCount);
      setPageWarning(ready.warning);
      await printCdtfaPages(ready.bytes);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not print the CDTFA form.');
    } finally { setBusy(false); }
  }

  async function downloadWorksheet() {
    if (!doc) return;
    setBusy(true); setError('');
    try {
      const district = lines.find((line) => line.id === '16')?.dollars ?? 0;
      const bytes = await buildCdtfaWorksheet({
        periodStart: doc.period_start,
        periodEnd: doc.period_end,
        dueOn: doc.due_on,
        fileOn,
        late,
        lines,
        pageCount: pageCount ?? (district > 0 ? 18 : 3),
        scheduleIncluded: district > 0 && !pageWarning,
      });
      saveFile(bytes, `CDTFA-worksheet_${doc.period_start.slice(0, 7)}_Open-Box-Industries.pdf`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the worksheet.');
    } finally { setBusy(false); }
  }

  async function markFiled() {
    if (!doc) return;
    setBusy(true); setError('');
    const result = await client.rpc('portal_mark_cdtfa_filed', {
      p_start: doc.period_start,
      p_end: doc.period_end,
      p_filed_on: fileOn,
      p_paid_how: paidHow,
      p_confirmation: confirmation,
    });
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    setFilings((prev) => {
      const next = prev.filter((row) => !(row.period_start === doc.period_start && row.period_end === doc.period_end));
      next.unshift({ period_start: doc.period_start, period_end: doc.period_end, filed_on: fileOn, paid_how: paidHow, confirmation });
      return next;
    });
  }

  const due = lines.find((line) => line.id === '26')?.dollars ?? 0;
  const pagesLabel = pageCount == null ? 'the return' : `${pageCount} page${pageCount === 1 ? '' : 's'}`;
  const pastDue = !!doc && today > (doc.due_on || dueOn(doc.period_end)) && !marked;
  const actions = doc && (
    <div className="cdtfa-actions">
      <button type="button" className="primary" onClick={() => void printReturn()} disabled={busy}>Print {pagesLabel}</button>
      <a href="https://onlineservices.cdtfa.ca.gov/" target="_blank" rel="noreferrer">File online at CDTFA</a>
      <button type="button" onClick={() => void downloadPdf(false)} disabled={busy}>Download return</button>
      <button type="button" onClick={() => void downloadWorksheet()} disabled={busy}>Download worksheet</button>
      <button type="button" className="cdtfa-full" onClick={() => void downloadPdf(true)} disabled={busy}>Download the full form with schedule</button>
    </div>
  );
  const summary = doc && (
    <div className="cdtfa-summary">
      {option?.title && <p className="cdtfa-option">{option.title}</p>}
      {option?.hint && <p className="cdtfa-option-hint">{option.hint}</p>}
      <p className="cdtfa-due-label">Total due</p>
      <strong className="cdtfa-due-figure">${due.toLocaleString('en-US')}</strong>
      <span className="cdtfa-badge">{doc.open ? 'Draft — period open' : doc.locked ? 'Locked' : 'Ready'}</span>
      <ul className="cdtfa-checks">
        {doc.checks.map((check) => (
          <li key={check.id} className={check.ok ? 'ok' : 'cdtfa-bad'}>{check.ok ? '✓ ' : ''}{check.detail}</li>
        ))}
      </ul>
      {layout !== 'phone' && actions}
    </div>
  );

  return (
    <section className={`cdtfa-sheet cdtfa-layout-${layout}`}>
      <div className="cdtfa-toolbar">
        <label>Filing period
          <select aria-label="Filing period" value={periodStart} disabled={!choices.length || busy} onChange={(e) => onPeriod(e.target.value)}>
            {choices.map((choice) => <option key={choice.start} value={choice.start}>{choice.label}</option>)}
          </select>
        </label>
        <div className="cdtfa-freq" role="group" aria-label="Assigned filing schedule">
          <span>Assigned schedule</span>
          {FREQUENCIES.map(([id, name]) => (
            <button key={id} type="button" className={frequency === id ? 'on' : ''} disabled={busy} onClick={() => void chooseFrequency(id)}>{name}</button>
          ))}
        </div>
      </div>
      {error && <p className="cdtfa-bad" role="alert">{error}</p>}
      {pastDue && <p className="cdtfa-pastdue" role="alert">Past due. This return was due {doc?.due_on}. It has not been marked filed. Nothing has been sent to CDTFA.</p>}
      {marked && <p className="cdtfa-note">Marked filed {marked.filed_on}{marked.paid_how ? ` · ${marked.paid_how}` : ''}{marked.confirmation ? ` · ${marked.confirmation}` : ''}. Nothing was sent to CDTFA.</p>}
      {doc && (
        <div className="cdtfa-split">
          {layout === 'phone' && summary}
          <div className="cdtfa-form">
            <p className="cdtfa-note">Prints only what you need: pages 1–3 of CDTFA-401-A always, and Schedule A2 only when line 16 is over $0. Instruction and example pages are left out. This return is {pagesLabel}. The template is REV. 126 (1-26); a page this version does not recognize keeps the whole file.</p>
            {pageWarning && <p className="cdtfa-bad">{pageWarning}</p>}
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
              recordsNote={recordsNote}
              optionTitle={null}
              optionHint={null}
              roundingNote={roundGap}
              money={money}
              readOnly={editsLocked}
              layout={layout}
              showQuiet={showAll}
              onDollars={(id, dollars) => {
                const floor = doc.lines.find((line) => line.id === id)?.dollars;
                void save(id, dollars != null && dollars === floor ? null : dollars, null);
              }}
              onSigner={(field, value) => void save(field, null, value)}
            />
            {layout === 'phone' && !showAll && <button type="button" className="cdtfa-show-all" onClick={() => setShowAll(true)}>Show all lines</button>}
            <p className="cdtfa-note">{doc.due_note}</p>
            <div className="cdtfa-file">
              <label>Filing date
                <input type="date" aria-label="Filing date" value={fileOn} onChange={(e) => { setFileTouched(true); setFileOn(e.target.value); }} />
              </label>
              <label>Paid preparer name
                <input aria-label="Paid preparer name" value={preparer} autoComplete="off" placeholder="Leave blank" onChange={(e) => setPreparer(e.target.value)} onBlur={() => void save('preparer', null, preparer)} />
              </label>
              <p className="cdtfa-note">The account number above is copied into every YOUR ACCOUNT NUMBER box. Leave paid preparer blank unless someone else prepares the return. {late && <>Line 25 stays blank. <a href="https://cdtfa.ca.gov/taxes-and-fees/interest-calculation.htm" target="_blank" rel="noreferrer">CDTFA interest calculation tool</a>.</>}</p>
              <label>How it was paid
                <input aria-label="How it was paid" value={paidHow} onChange={(e) => setPaidHow(e.target.value)} />
              </label>
              <label>Confirmation number
                <input aria-label="Confirmation number" value={confirmation} autoComplete="off" onChange={(e) => setConfirmation(e.target.value)} />
              </label>
              <button type="button" onClick={() => void markFiled()} disabled={busy || !paidHow.trim()}>Mark as filed</button>
            </div>
            {filings.length > 0 && (
              <section className="cdtfa-history">
                <h3>Filed returns</h3>
                <ul>
                  {filings.map((row) => (
                    <li key={`${row.period_start}-${row.period_end}`}>{row.period_start} filed {row.filed_on}{row.paid_how ? ` · ${row.paid_how}` : ''}</li>
                  ))}
                </ul>
              </section>
            )}
            {layout === 'phone' && actions}
          </div>
          {layout === 'desk' && summary}
        </div>
      )}
    </section>
  );
}
