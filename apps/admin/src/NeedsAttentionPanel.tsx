import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AttentionSection } from './navigation';
import { MissingCostPage } from './MissingCostPage';
import { MissingFieldPage } from './MissingFieldPage';

type Props = {
  client: SupabaseClient;
  storeId: string;
  money: (n: number) => string;
  stamp: (s: string) => string;
  section: Exclude<AttentionSection, 'all'>;
  onCostChanged: () => void;
};

type FieldKind = 'brand' | 'category' | 'specifics' | 'spec' | 'upc' | 'photo' | 'price' | 'condition' | 'model' | 'description';

/**
 * Fix queues under Inventory → Unfinished (this used to be its own Needs attention tab).
 * The server skips not-for-sale units in every queue except Missing brand.
 */
export const ATTENTION_SECTIONS: [Exclude<AttentionSection, 'all'>, string, FieldKind | 'cost'][] = [
  ['missing-photo', 'Missing photo', 'photo'],
  ['missing-price', 'Missing price', 'price'],
  ['missing-brand', 'Missing brand', 'brand'],
  ['missing-condition', 'Missing condition', 'condition'],
  ['missing-category', 'Missing category', 'category'],
  ['missing-upc', 'Missing UPC', 'upc'],
  ['missing-spec', 'Missing weight & dimensions', 'spec'],
  ['missing-model', 'Missing model', 'model'],
  ['missing-specifics', 'Missing item specifics', 'specifics'],
  ['missing-description', 'Missing description', 'description'],
  ['missing-cost', 'Missing cost', 'cost'],
];

/** Per-queue counts, fetched in parallel. Null while loading or on error. */
export function useAttentionCounts(client: SupabaseClient, enabled: boolean, refresh = 0) {
  const [counts, setCounts] = useState<Partial<Record<AttentionSection, number>>>({});
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void Promise.all(ATTENTION_SECTIONS.map(async ([id, , kind]) => {
      const { data, error } = kind === 'cost'
        ? await client.rpc('portal_units_missing_cost', { p_limit: 1, p_offset: 0 })
        : await client.rpc('portal_units_missing_field', { p_kind: kind, p_limit: 1, p_offset: 0 });
      return [id, error ? undefined : Number((data as { total?: number })?.total || 0)] as const;
    })).then(rows => {
      if (alive) setCounts(Object.fromEntries(rows.filter(([, n]) => n !== undefined)));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [client, enabled, refresh]);
  return counts;
}

export function NeedsAttentionPanel({ client, storeId, money, stamp, section, onCostChanged }: Props) {
  const kind = ATTENTION_SECTIONS.find(([id]) => id === section)?.[2] ?? 'cost';
  return kind === 'cost'
    ? <MissingCostPage client={client} money={money} stamp={stamp} onChanged={onCostChanged} embedded />
    : <MissingFieldPage client={client} storeId={storeId} kind={kind} money={money} stamp={stamp} />;
}
