/**
 * Bundle / combined-shipping / proposed-refund UI — removed from Orders.
 * Server apply/enable/preview is gated OFF via FLOOR_BUNDLE_PRICE_APPLY (see shared/bundle-apply-gate.mjs).
 * Keep this stub so old imports compile; it renders nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebOrder } from './OrdersPage';
import type { UnitPhoto } from './unitPhotos';

type Props = {
  client: SupabaseClient;
  accessToken: string;
  orders: WebOrder[];
  segmentIds: string[];
  locations: Record<string, string[]>;
  photoUrls: Record<string, string>;
  photoMap: Record<string, UnitPhoto[]>;
  money: (n: number) => string;
  isAdmin: boolean;
  onRefresh: () => void;
  onMembers: (ids: string[]) => void;
};

/** @deprecated Orders no longer show bundle / proposed-refund chrome. */
export function BundleBar(_props: Props) {
  return null;
}
