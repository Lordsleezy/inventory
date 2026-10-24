import type { SupabaseClient } from '@supabase/supabase-js';
import type { AttentionSection } from './navigation';
import { MissingCostPage } from './MissingCostPage';
import { MissingFieldPage } from './MissingFieldPage';

type Props = {
  client: SupabaseClient;
  storeId: string;
  money: (n: number) => string;
  stamp: (s: string) => string;
  section: AttentionSection;
  onSection: (s: AttentionSection) => void;
  onCostChanged: () => void;
};

const TABS: [AttentionSection, string][] = [
  ['missing-brand', 'Missing brand'],
  ['missing-category', 'Missing category'],
  ['missing-specifics', 'Missing item specifics'],
  ['missing-spec', 'Missing weight & dimensions'],
  ['missing-upc', 'Missing UPC'],
  ['missing-photo', 'Missing photo'],
  ['missing-price', 'Missing price'],
  ['missing-condition', 'Missing condition'],
  ['missing-cost', 'Missing cost'],
  ['missing-model', 'Missing model'],
  ['missing-description', 'Missing description'],
];

export function NeedsAttentionPanel({
  client,
  storeId,
  money,
  stamp,
  section,
  onSection,
  onCostChanged,
}: Props) {
  const active = TABS.some(([id]) => id === section) ? section : 'missing-cost';

  return (
    <>
      <div className="inventory-tabs report-tabs">
        {TABS.map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={active === id ? 'active' : ''}
            onClick={() => onSection(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {active === 'missing-cost' && (
        <MissingCostPage client={client} money={money} stamp={stamp} onChanged={onCostChanged} embedded />
      )}
      {active === 'missing-brand' && (
        <MissingFieldPage client={client} storeId={storeId} kind="brand" money={money} stamp={stamp} />
      )}
      {active === 'missing-category' && (
        <MissingFieldPage client={client} storeId={storeId} kind="category" money={money} stamp={stamp} />
      )}
      {active === 'missing-specifics' && (
        <MissingFieldPage client={client} storeId={storeId} kind="specifics" money={money} stamp={stamp} />
      )}
      {active === 'missing-upc' && (
        <MissingFieldPage client={client} storeId={storeId} kind="upc" money={money} stamp={stamp} />
      )}
      {active === 'missing-condition' && (
        <MissingFieldPage client={client} storeId={storeId} kind="condition" money={money} stamp={stamp} />
      )}
      {active === 'missing-photo' && (
        <MissingFieldPage client={client} storeId={storeId} kind="photo" money={money} stamp={stamp} />
      )}
      {active === 'missing-price' && (
        <MissingFieldPage client={client} storeId={storeId} kind="price" money={money} stamp={stamp} />
      )}
      {active === 'missing-spec' && (
        <MissingFieldPage client={client} storeId={storeId} kind="spec" money={money} stamp={stamp} />
      )}
      {active === 'missing-model' && (
        <MissingFieldPage client={client} storeId={storeId} kind="model" money={money} stamp={stamp} />
      )}
      {active === 'missing-description' && (
        <MissingFieldPage client={client} storeId={storeId} kind="description" money={money} stamp={stamp} />
      )}
    </>
  );
}
