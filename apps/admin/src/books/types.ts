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

export type FrozenMap = Map<string, number | null>;

export type BooksPayoutContext = {
  rules: import('../payouts').Rule[];
  cfg: import('../payouts').OnlineCfg;
  frozen: FrozenMap;
  staff: { user_id: string; display_name: string; email?: string | null }[];
  peopleSlots: { slot: string; employee_id: string | null }[];
};

export type DuplicatePair = {
  id: string;
  primary: ExpenseDisplayLine;
  duplicate: ExpenseDisplayLine;
};

export type DuplicateNote = { message: string; lineIds: string[]; pair?: DuplicatePair };

export type ExpenseDisplayLine = {
  id: string;
  date: string;
  category: string;
  title: string;
  amount_cents: number;
  sourceDisplay: string;
  sku_or_order: string;
  needs_reimbursement: boolean;
  countsInProfit: boolean;
  kindKey: string;
  excludeFromTotals: boolean;
  duplicateFlag?: boolean;
  meta?: string;
  children?: ExpenseDisplayLine[];
};

export type MoneyOverviewRow = { account: string; balance_cents: number };

export type MoneyActivityRow = {
  id: string;
  at: string;
  direction: 'in' | 'out' | 'none';
  amount_cents: number;
  reason: string;
  note: string;
  auto?: boolean;
};

export type StoreMoneyMonth = {
  account: string;
  label: string;
  start_balance_cents: number | null;
  start_balance_estimated?: boolean;
  money_in_cents: number;
  paid_to_bank_cents: number;
  end_balance_cents: number | null;
  end_balance_estimated?: boolean;
  transfers: MoneyActivityRow[];
};

export type CommissionPayoutLine = {
  person: string;
  role: 'staff' | 'owner';
  earned_cents: number;
  paid_cents: number;
  owed_all_time_cents: number;
};

export type PayoutsWorkbook = {
  stores: StoreMoneyMonth[];
  bankPaidTotal_cents: number;
  commissions: CommissionPayoutLine[];
  commission_total_cents: number;
  stillOwed_all_time_cents: number;
  owner: { profit: number; commission: number; otherExpenses: number; ownerKeeps: number };
};

export type Report = {
  period: Period;
  checks: Check[];
  books_workbook_version?: number;
  books_attributed_fee_ids?: string[];
  books_label_dedup_expense_ids?: string[];
  books_label_dedup_label_ids?: string[];
  books_unmatched_labels?: { id: string; date: string; amount_cents: number; title: string }[];
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
  otherExpenses: number;
  ownerKeeps: number;
  /** Buyer shipping above label cost (included in derived profit). */
  shippingSurplus: number;
  /** Ledger profit minus derived — should be ~0 after fee attribution. */
  ledgerProfitGap: number;
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

export type MonthProof = {
  revenue: number;
  cost: number;
  feesAndLabels: number;
  profit: number;
  commission: number;
  ownerBeforeOther: number;
  saleCount: number;
  pendingCost: number;
};

export type BooksWorkbook = {
  proof: MonthProof;
  audit: { ticketKey: string; message: string }[];
  exportTieIssues?: { check: string; message: string }[];
  integrity?: { ok: boolean; commissionGap_cents: number; ownerGap_cents: number; issues: { kind: string; message: string; cents?: number; saleId?: string }[] };
  expenses: {
    rows: ExpenseDisplayLine[];
    exportRows: ExpenseLine[];
    categoryTotals: { category: string; amount_cents: number }[];
    total_cents: number;
    reimburse_cents: number;
    otherExpenses_cents: number;
    duplicates: DuplicateNote[];
  };
  sales: { rows: SalesLine[]; channelTotals: { channel: string; revenue_cents: number; profit_cents: number; count: number }[]; totals: BookTotals };
  payouts: PayoutsWorkbook;
  inventory: InventorySummary;
  received: ReceivedItem[];
};
