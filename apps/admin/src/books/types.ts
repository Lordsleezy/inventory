export type Row = Record<string, unknown>;

export type Period = {
  id: string;
  period_type: 'month' | 'week';
  period_start: string;
  period_end: string;
  status: 'draft' | 'ready' | 'locked';
  locked_at: string | null;
  locked_by_name?: string | null;
};

export type Check = {
  key: string;
  label: string;
  ok: boolean;
  count: number;
  detail: string;
  explanation: string | null;
};

export type Report = {
  period: Period;
  checks: Check[];
  sales: Row[];
  fees: Row[];
  labels: Row[];
  expenses: Row[];
  returns: Row[];
  dispositions: Row[];
  inventory_bought: Row[];
  manifests: Row[];
  payouts: Row[];
  payout_balances: Row[];
  payments: Row[];
  square_payments?: Row[];
  adjustments: Row[];
  prior_corrections: Row[];
  withdrawals: Row[];
  money_trail: Row[];
  inventory_summary?: InventorySummary;
  items_received?: ReceivedItem[];
};

export type InventorySummary = {
  start_unit_count: number;
  end_unit_count: number;
  start_source: string;
  end_source: string;
  sold_units: number;
  received_units: number;
  giveaway_units: number;
  replacement_units: number;
  return_count: number;
  return_to_stock_units: number;
  defective_units: number;
  giveaways: Row[];
  replacements: Row[];
  returns: Row[];
  defective_moves: Row[];
};

export type ReceivedItem = Row;

export type BookTotals = {
  revenue: number;
  cost: number;
  fees: number;
  labelCostsOnSales: number;
  feesAndLabels: number;
  commission: number;
  profit: number;
  expense: number;
};

export type ExpenseLine = {
  date: string;
  category: string;
  description: string;
  amount_cents: number;
  sku_or_order: string;
  paid_by: string;
  needs_reimbursement: string;
  source: string;
};

export type SalesLine = {
  sale_id: string;
  date: string;
  sku: string;
  title: string;
  channel: string;
  order_no: string;
  qty: number;
  price_cents: number;
  tax_cents: number;
  marketplace_fees_cents: number;
  card_fees_cents: number;
  buyer_shipping_cents: number;
  label_cost_cents: number;
  cost_cents: number | null;
  profit_cents: number | null;
  commission_cents: number | null;
  profit_notes: string;
};

export type BooksWorkbook = {
  expenses: { rows: ExpenseLine[]; categoryTotals: { category: string; amount_cents: number }[]; total_cents: number };
  sales: { rows: SalesLine[]; channelTotals: { channel: string; revenue_cents: number; profit_cents: number; count: number }[]; totals: BookTotals };
  inventory: InventorySummary;
  received: ReceivedItem[];
};
