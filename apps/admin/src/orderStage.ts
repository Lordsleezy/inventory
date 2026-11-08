export type OrderStage = 'toShip' | 'packaged' | 'shipped' | 'delivered' | 'canceled' | 'pickup';

export type StageOrder = {
  status?: string | null;
  fulfillment?: string | null;
  channel?: string | null;
  packaged_at?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
  picked_up_at?: string | null;
  paid_at?: string | null;
  label_url?: string | null;
  label_storage_path?: string | null;
  label_uploaded_at?: string | null;
  label_purchased_at?: string | null;
  label_origin?: string | null;
  label_cost_cents?: number | null;
  tracking_number?: string | null;
  tracking_exception?: string | null;
  tracking_status?: string | null;
  carrier?: string | null;
  item_cents?: number | null;
  title?: string | null;
  sku?: string | null;
};

const TWO_DAYS = 2 * 86400000;

export function canBuyLabel(channel?: string | null) {
  const ch = (channel || 'website').toLowerCase();
  return ch === 'website' || ch === 'web' || ch === 'ebay' || ch === 'amazon' || ch === 'tiktok';
}

export function orderStage(o: StageOrder): OrderStage {
  if (o.status === 'canceled' || o.status === 'refunded') return 'canceled';
  if (o.fulfillment === 'pickup') return o.picked_up_at ? 'delivered' : 'pickup';
  if (o.delivered_at) return 'delivered';
  if (o.shipped_at) return 'shipped';
  if (o.packaged_at) return 'packaged';
  return 'toShip';
}

export function hasLabel(o: StageOrder) {
  return !!(o.label_url || o.label_storage_path || o.label_uploaded_at || o.label_purchased_at);
}

export function packagedStale(o: StageOrder, now = Date.now()) {
  if (!o.packaged_at || o.shipped_at || o.delivered_at) return false;
  const at = new Date(o.packaged_at).getTime();
  if (!Number.isFinite(at)) return false;
  return now - at > TWO_DAYS;
}

export function trackingTail(o: StageOrder) {
  const n = String(o.tracking_number || '').replace(/\s+/g, '');
  if (n.length < 4) return '';
  const carrier = (o.carrier || 'USPS').split(' ')[0];
  return `${carrier} …${n.slice(-4)}`;
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
}

export function orderChip(o: StageOrder, now = Date.now()): { text: string; tone: 'warn' | 'ok' | 'muted' | 'blue' } {
  const stage = orderStage(o);
  if (o.tracking_exception && stage !== 'canceled' && stage !== 'delivered') {
    return { text: 'Exception', tone: 'warn' };
  }
  if (stage === 'canceled') return { text: 'Canceled', tone: 'muted' };
  if (stage === 'pickup') return { text: 'Ready for pickup', tone: 'ok' };
  if (stage === 'delivered') {
    return { text: o.picked_up_at && !o.delivered_at ? 'Picked up' : 'Delivered', tone: 'muted' };
  }
  if (stage === 'shipped') return { text: 'Shipped', tone: 'ok' };
  if (stage === 'packaged') {
    if (packagedStale(o, now)) return { text: 'No scan · 2+ days', tone: 'warn' };
    const t = o.packaged_at ? clock(o.packaged_at) : '';
    return { text: t ? `Packaged ${t} · waiting on scan` : 'Packaged · waiting on scan', tone: 'blue' };
  }
  if (hasLabel(o)) return { text: 'Label ready · Print', tone: 'ok' };
  if (canBuyLabel(o.channel)) return { text: 'Buy label', tone: 'warn' };
  return { text: 'Add label', tone: 'warn' };
}

export type TimelineRow = { title: string; detail: string; at: string | null; tone?: 'ok' | 'warn' | 'muted' };

export function orderTimeline(o: StageOrder & {
  label_file_name?: string | null;
  packaged_by_name?: string | null;
  service?: string | null;
}, events: { status?: string; status_detail?: string | null; location?: string | null; occurred_at?: string | null }[] = []): TimelineRow[] {
  const rows: TimelineRow[] = [];
  if (o.label_purchased_at && o.label_origin !== 'upload') {
    const cost = o.label_cost_cents != null ? `$${(o.label_cost_cents / 100).toFixed(2)}` : '';
    rows.push({
      title: 'Label bought',
      detail: [o.carrier, o.service, cost].filter(Boolean).join(' · '),
      at: o.label_purchased_at,
    });
  }
  if (o.label_uploaded_at || o.label_origin === 'upload') {
    rows.push({
      title: 'Label uploaded',
      detail: o.label_file_name || 'Depop label',
      at: o.label_uploaded_at || null,
    });
  }
  if (o.packaged_at) {
    rows.push({
      title: 'Packaged',
      detail: o.packaged_by_name ? `by ${o.packaged_by_name}` : '',
      at: o.packaged_at,
    });
  }
  for (const ev of events) {
    const status = String(ev.status || '').toUpperCase();
    const title = status === 'DELIVERED' ? 'Delivered'
      : status === 'TRANSIT' ? (ev.status_detail || 'In transit')
        : status === 'PRE_TRANSIT' ? (ev.status_detail || 'Label created')
          : status === 'RETURNED' || status === 'FAILURE' ? (ev.status_detail || 'Exception')
            : (ev.status_detail || status || 'Update');
    rows.push({
      title,
      detail: ev.location || '',
      at: ev.occurred_at || null,
      tone: status === 'RETURNED' || status === 'FAILURE' ? 'warn' : status === 'DELIVERED' ? 'ok' : undefined,
    });
  }
  if (o.delivered_at && !rows.some((r) => r.title === 'Delivered')) {
    rows.push({ title: 'Delivered', detail: 'Carrier confirmed', at: o.delivered_at, tone: 'ok' });
  }
  return rows.sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0;
    const tb = b.at ? new Date(b.at).getTime() : 0;
    return tb - ta;
  });
}

export const STAGE_INDEX: Record<OrderStage, number> = {
  toShip: 0, packaged: 1, shipped: 2, delivered: 3, canceled: -1, pickup: -1,
};
