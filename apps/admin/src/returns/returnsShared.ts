export type Refund = {
  id: string;
  amount_cents: number;
  refunded_on: string;
  channel: string;
  kind: string;
  item_kept: boolean;
  note: string | null;
  created_at: string;
};

export type ReturnRow = {
  id: string;
  kind?: string;
  sku: string;
  title?: string;
  channel: string;
  status: string;
  reason: string;
  fault?: string | null;
  external_order_id: string | null;
  buyer_name?: string | null;
  refund_cents: number;
  return_label_cents: number;
  label_paid_by: string;
  tracking_number?: string | null;
  carrier?: string | null;
  requested_qty?: number;
  replacement_sku?: string | null;
  sale_id?: number | null;
  route_to?: string;
  created_at: string;
  label_sent_at?: string | null;
  in_transit_at?: string | null;
  received_at?: string | null;
  closed_at?: string | null;
  refunded_at?: string | null;
  refunds?: Refund[];
};

export type Candidate = {
  sale_id: number;
  sku: string;
  title: string;
  qty: number;
  qty_open: number;
  channel: string;
  price_cents: number;
  buyer: string | null;
  order_ref: string;
  hint_refund_cents?: number | null;
  hint_tracking?: string | null;
};

export type TrackingEvent = {
  status: string;
  status_detail?: string | null;
  location?: string | null;
  occurred_at: string;
  carrier?: string | null;
  current?: boolean;
};

export type TrackingBundle = {
  status_line: string;
  eta?: string | null;
  carrier?: string | null;
  events: TrackingEvent[];
  tracking_source?: string | null;
};

export const STATUS_LABEL: Record<string, string> = {
  requested: 'Requested',
  label_sent: 'Label sent',
  approved: 'Label sent',
  in_transit: 'In transit',
  received: 'Received',
  inspected: 'Received',
  dispositioned: 'Closed',
  closed: 'Closed',
  refunded_no_return: 'Kept item',
  denied: 'Closed',
  canceled: 'Closed',
};

export function statusLabel(status: string, routeTo?: string) {
  if (status === 'refunded_no_return' || routeTo === 'buyer_keeps') return 'Kept item';
  return STATUS_LABEL[status] || status.replace(/_/g, ' ');
}

export function statusTone(status: string, routeTo?: string): 'warn' | 'ok' | 'info' | 'muted' {
  const s = routeTo === 'buyer_keeps' ? 'kept' : status;
  if (s === 'requested' || s === 'label_sent' || s === 'approved') return 'warn';
  if (s === 'in_transit') return 'info';
  if (s === 'received' || s === 'inspected') return 'ok';
  if (s === 'kept' || s === 'refunded_no_return') return 'muted';
  return 'muted';
}

export function laToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

export function cents(raw: string) {
  const n = Math.round(Number(String(raw).replace(/[$,\s]/g, '')) * 100);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function dollars(centsVal: number) {
  return (centsVal / 100).toFixed(2);
}
