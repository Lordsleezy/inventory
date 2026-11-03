import type { SupabaseClient } from '@supabase/supabase-js';
import { ReturnsSimplified } from './returns/ReturnsSimplified';

type Props = {
  client: SupabaseClient;
  storeId: string;
  money: (n: number) => string;
  stamp: (s: string) => string;
  variant?: 'desktop' | 'app';
  accessToken?: string;
};

export type { ReturnRow } from './returns/returnsShared';

export function ReturnsPage({ client, storeId, money, stamp, variant = 'desktop', accessToken }: Props) {
  return (
    <ReturnsSimplified
      client={client}
      storeId={storeId}
      money={money}
      stamp={stamp}
      variant={variant === 'app' ? 'app' : 'desktop'}
      accessToken={accessToken}
    />
  );
}
