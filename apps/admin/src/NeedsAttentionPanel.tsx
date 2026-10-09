import type { SupabaseClient } from '@supabase/supabase-js';
import type { AttentionSection } from './navigation';
import { YourCallPanel } from './YourCallPanel';
import { MissingCostPage } from './MissingCostPage';
import { ReviewMatchesPage } from './ReviewMatchesPage';

type Props = {
  client: SupabaseClient;
  accessToken: string;
  money: (n: number) => string;
  stamp: (s: string) => string;
  busy: boolean;
  run: (f: () => Promise<void>) => Promise<void>;
  section: AttentionSection;
  onSection: (s: AttentionSection) => void;
  onCostChanged: () => void;
};

export function NeedsAttentionPanel({ client, accessToken, money, stamp, busy, run, section, onSection, onCostChanged }: Props) {
  return <>
    <div className="inventory-tabs report-tabs">
      <button type="button" className={section === 'your-call' ? 'active' : ''} onClick={() => onSection('your-call')}>Your Call</button>
      <button type="button" className={section === 'missing-cost' ? 'active' : ''} onClick={() => onSection('missing-cost')}>Missing cost</button>
      <button type="button" className={section === 'reviews' ? 'active' : ''} onClick={() => onSection('reviews')}>Review matches</button>
    </div>
    {section === 'your-call' && <YourCallPanel client={client} money={money} busy={busy} run={run} embedded />}
    {section === 'missing-cost' && <MissingCostPage client={client} money={money} stamp={stamp} onChanged={onCostChanged} embedded />}
    {section === 'reviews' && <ReviewMatchesPage client={client} accessToken={accessToken} embedded />}
  </>;
}
