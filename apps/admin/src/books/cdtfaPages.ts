export type CdtfaPageKind = 'return' | 'schedule' | 'instructions' | 'example' | 'unknown';

/** Classify one page from the words printed on it, not from its position in the file. */
export function classifyCdtfaPage(text: string): CdtfaPageKind {
  const flat = text.replace(/\s+/g, ' ');
  if (/INSTRUCTIONS FOR COMPLETING/i.test(flat)) return 'instructions';
  if (/Fixed-price contract example/i.test(flat)) return 'example';
  // The worked example says "ALLOCATE TO CORRECT DISTRICT" and leaves out "LINE A4".
  if (/ALLOCATE TO CORRECT DISTRICT/i.test(flat) && !/ALLOCATE LINE A4/i.test(flat)) return 'example';
  if (/CDTFA-401-A \(S(?:1F|1B|2)\)/.test(flat)) return 'return';
  if (/CDTFA-531-A2|SCHEDULE A2/i.test(flat)) return 'schedule';
  return 'unknown';
}

export type CdtfaPagePlan = {
  keep: number[];
  kinds: CdtfaPageKind[];
  warning: string | null;
};

/**
 * Pages 1–3 of CDTFA-401-A stay.
 * Schedule A2 stays only when district tax is above zero, and then the whole schedule stays.
 * Instruction and example pages never stay.
 * An unrecognized page keeps the entire file.
 */
export function selectCdtfaPages(texts: string[], districtTax: number): CdtfaPagePlan {
  const kinds = texts.map(classifyCdtfaPage);
  if (kinds.some((kind) => kind === 'unknown')) {
    return {
      keep: texts.map((_, index) => index),
      kinds,
      warning: 'This form revision has a page Floor does not recognize, so the download is the full file.',
    };
  }
  const wantSchedule = districtTax > 0;
  const keep = kinds.flatMap((kind, index) => {
    if (kind === 'return') return [index];
    if (kind === 'schedule' && wantSchedule) return [index];
    return [];
  });
  return { keep, kinds, warning: null };
}
