import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaperLine, PaperSale, PaperSigner } from './CdtfaPaper';
import { dueOn, filingBounds, periodLabel, resolveCdtfaDollars, type CdtfaFrequency } from './cdtfaResolve';

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

export async function loadCdtfaPrintModel(client: SupabaseClient, monthStart: string): Promise<CdtfaPrintModel | null> {
  const filing = await client.rpc('portal_cdtfa_filing');
  if (filing.error) return null;
  const frequency = (filing.data as CdtfaFrequency) || 'quarterly';
  const period = filingBounds(monthStart, frequency);
  const [result, saved] = await Promise.all([
    client.rpc('portal_cdtfa_return', { p_start: period.start, p_end: period.end }),
    client.rpc('portal_cdtfa_edits', { p_start: period.start, p_end: period.end }),
  ]);
  if (result.error || !result.data) return null;
  const doc = result.data as Doc;
  const raw = (saved.data || {}) as Record<string, { dollars: number | null; text: string | null }>;
  const edits: Record<string, number | undefined> = {};
  const signer: PaperSigner = { name: '', title: '', date: '', email: '', phone: '', account: '' };
  for (const [field, value] of Object.entries(raw)) {
    if (SIGNER.includes(field as typeof SIGNER[number])) signer[field as keyof PaperSigner] = value.text || '';
    else if (value.dollars != null) edits[field] = value.dollars;
  }
  const collected = Math.round(Number(doc.collected_cents || 0) / 100);
  const resolved = new Map(resolveCdtfaDollars(doc.lines, edits, collected).map((row) => [row.id, row]));
  return {
    lines: doc.lines.map((line) => {
      const row = resolved.get(line.id);
      return { ...line, dollars: row?.dollars ?? line.dollars, floor: line.dollars, edited: !!row?.edited, sales: line.sales || [], note: line.note || '' };
    }),
    signer,
    open: doc.open,
    locked: doc.locked,
    periodLabel: periodLabel(doc.period_start, doc.period_end, frequency, doc.due_on),
    periodStart: doc.period_start,
    periodEnd: doc.period_end,
    dueOn: doc.due_on || dueOn(doc.period_end),
    scheduleNote: doc.schedule_a2?.note || doc.place || '',
    districtMeasure: edits.A4 ?? 0,
    districtMeasureEdited: edits.A4 != null,
  };
}
