import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cachedLabelPaper, refreshLabelPaper, saveLabelPaper } from './labelPrint';
import type { LabelPaper } from './labelSheet';

export function LabelPaperSetting({ client }: { client: SupabaseClient }) {
  const [paper, setPaper] = useState<LabelPaper>(cachedLabelPaper);
  const [note, setNote] = useState('');

  useEffect(() => {
    void refreshLabelPaper(client).then(setPaper).catch(() => undefined);
  }, [client]);

  async function choose(next: LabelPaper) {
    setNote('');
    setPaper(next);
    try {
      setPaper(await saveLabelPaper(client, next));
      setNote('Saved');
    } catch {
      setNote('Could not save.');
    }
  }

  return (
    <section className="panel">
      <h2>Shipping labels</h2>
      <p className="hint">4×6 label printer is the default. Letter paper prints the label large in the top-left quarter of the sheet so it can be cut out.</p>
      <div className="label-paper-choices">
        <button type="button" aria-pressed={paper === 'label'} onClick={() => void choose('label')}>4×6 label printer</button>
        <button type="button" aria-pressed={paper === 'letter'} onClick={() => void choose('letter')}>Letter paper (quarter page)</button>
      </div>
      {note && <p className="hint">{note}</p>}
    </section>
  );
}
