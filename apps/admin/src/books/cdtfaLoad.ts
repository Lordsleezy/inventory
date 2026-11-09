import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaperLine, PaperSale, PaperSigner } from './CdtfaPaper';
import { dueOn, periodLabel, resolveCdtfaDollars, type CdtfaFrequency } from './cdtfaResolve';
import { filingOption, formKind, monthsInRange, parseFiling, recordsStamp, spanBounds, spanFrequency } from './booksSpan';
import { roundingNote } from './cdtfaRoundNote';

export type CdtfaPrintModel = {
  lines: PaperLine[];
  signer: PaperSigner;
  open: boolean;
  locked: boolean;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  dueOn: string;
  scheduleNote: string;
  districtMeasure: number;
  districtMeasureEdited: boolean;
  recordsNote: string | null;
  optionTitle: string | null;
  optionHint: string | null;
  roundingNote: string | null;
  late: boolean;
  omitInterest: boolean;
  preparer: string;
};

type FloorLine = { id: string; label: string; dollars: number; note: string; sales?: PaperSale[] };
type Doc = {
  frequency?: CdtfaFrequency;
  period_start: string; period_end: string; due_on: string; open: boolean; locked: boolean;
  lines: FloorLine[];
  schedule_a2?: { note: string };
  place?: string;
  collected_cents?: number;
};

const SIGNER = ['name', 'title', 'date', 'email', 'phone', 'account'] as const;

export async function loadCdtfaPrintModel(client: SupabaseClient, periodStart: string, periodEnd: string): Promise<CdtfaPrintModel | null> {
  const filing = await client.rpc('portal_cdtfa_filing');
  if (filing.error) return null;
  const frequency = parseFiling(filing.data);
  const kind = formKind(periodStart, periodEnd);
  const [result, saved] = await Promise.all([
    client.rpc('portal_cdtfa_return', { p_start: periodStart, p_end: periodEnd }),
    client.rpc('portal_cdtfa_edits', { p_start: periodStart, p_end: periodEnd }),
  ]);
  if (result.error || !result.data) return null;
  const doc = result.data as Doc;
  const roundGap = await loadRoundingNote(client, doc);
  const raw = (saved.data || {}) as Record<string, { dollars: number | null; text: string | null }>;
  const edits: Record<string, number | undefined> = {};
  const signer: PaperSigner = { name: '', title: '', date: '', email: '', phone: '', account: '' };
  for (const [field, value] of Object.entries(raw)) {
    if (SIGNER.includes(field as typeof SIGNER[number])) signer[field as keyof PaperSigner] = value.text || '';
    else if (value.dollars != null) edits[field] = value.dollars;
  }
  const collected = Math.round(Number(doc.collected_cents || 0) / 100);
  const due = doc.due_on || dueOn(doc.period_end);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const late = today > due;
  const resolved = new Map(resolveCdtfaDollars(doc.lines, edits, collected, late).map((row) => [row.id, row]));
  return {
    lines: doc.lines.map((line) => {
      const row = resolved.get(line.id);
      return { ...line, dollars: row?.dollars ?? line.dollars, floor: line.dollars, edited: !!row?.edited, sales: line.sales || [], note: line.note || '' };
    }),
    signer,
    open: doc.open,
    locked: doc.locked,
    periodLabel: periodLabel(doc.period_start, doc.period_end, spanFrequency(kind), doc.due_on),
    periodStart: doc.period_start,
    periodEnd: doc.period_end,
    dueOn: due,
    scheduleNote: doc.schedule_a2?.note || doc.place || '',
    districtMeasure: edits.A4 ?? 0,
    districtMeasureEdited: edits.A4 != null,
    recordsNote: recordsStamp(kind, frequency),
    optionTitle: filingOption(kind, frequency)?.title ?? null,
    optionHint: filingOption(kind, frequency)?.hint ?? null,
    roundingNote: roundGap,
    late,
    omitInterest: late && edits['25'] == null,
    preparer: raw.preparer?.text || '',
  };
}

export async function loadCdtfaRoundingNote(client: SupabaseClient, lines: { id: string; dollars: number }[], start: string, end: string) {
  return loadRoundingNote(client, { period_start: start, period_end: end, due_on: '', open: false, locked: false, lines: lines as Doc['lines'] });
}

async function loadRoundingNote(client: SupabaseClient, doc: Doc) {
  const months = monthsInRange(doc.period_start, doc.period_end);
  if (months.length < 2) return null;
  const loaded = await Promise.all(months.map(async (month) => {
    const bounds = spanBounds(month, 'month');
    const result = await client.rpc('portal_cdtfa_return', { p_start: bounds.start, p_end: bounds.end });
    if (result.error || !result.data) return null;
    return (result.data as Doc).lines;
  }));
  if (loaded.some((rows) => !rows)) return null;
  return roundingNote(doc.lines, loaded as Doc['lines'][]);
}
