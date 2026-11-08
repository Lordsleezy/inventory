import type {
  BookTotals,
  BooksWorkbook,
  ExpenseDisplayLine,
  InventorySummary,
  MonthProof,
  PayoutsWorkbook,
  StoreMoneyMonth,
} from './types';

export type BooksSlice = { label: string; workbook: BooksWorkbook };

const TOTAL_KEYS: (keyof BookTotals)[] = [
  'revenue', 'cost', 'fees', 'labelCostsOnSales', 'feesAndLabels', 'commission',
  'profit', 'expense', 'otherExpenses', 'ownerKeeps', 'shippingSurplus', 'ledgerProfitGap',
];

export function combineMonthWorkbooks(slices: BooksSlice[]): BooksWorkbook {
  if (slices.length === 1) return slices[0].workbook;
  const books = slices.map((slice) => slice.workbook);
  const first = books[0];
  const last = books[books.length - 1];
  const totals = sumTotals(books.map((book) => book.sales.totals));
  const channel = new Map<string, { revenue_cents: number; profit_cents: number; count: number }>();
  for (const book of books) {
    for (const row of book.sales.channelTotals) {
      const item = channel.get(row.channel) || { revenue_cents: 0, profit_cents: 0, count: 0 };
      item.revenue_cents += row.revenue_cents;
      item.profit_cents += row.profit_cents;
      item.count += row.count;
      channel.set(row.channel, item);
    }
  }
  const categories = new Map<string, number>();
  for (const book of books) {
    for (const row of book.expenses.categoryTotals) categories.set(row.category, (categories.get(row.category) || 0) + row.amount_cents);
  }
  const expenses = {
    rows: books.flatMap((book) => book.expenses.rows),
    exportRows: books.flatMap((book) => book.expenses.exportRows),
    categoryTotals: [...categories.entries()].map(([category, amount_cents]) => ({ category, amount_cents })),
    total_cents: books.reduce((n, book) => n + book.expenses.total_cents, 0),
    reimburse_cents: books.reduce((n, book) => n + book.expenses.reimburse_cents, 0),
    otherExpenses_cents: books.reduce((n, book) => n + book.expenses.otherExpenses_cents, 0),
    duplicates: books.flatMap((book) => book.expenses.duplicates),
  };
  return {
    proof: sumProof(books.map((book) => book.proof)),
    audit: books.flatMap((book) => book.audit),
    costAudit: {
      missing: books.flatMap((book) => book.costAudit?.missing || []),
      flaggedDefaults: books.flatMap((book) => book.costAudit?.flaggedDefaults || []),
    },
    exportTieIssues: books.flatMap((book) => book.exportTieIssues || []),
    integrity: {
      ok: books.every((book) => book.integrity?.ok !== false),
      commissionGap_cents: books.reduce((n, book) => n + (book.integrity?.commissionGap_cents || 0), 0),
      ownerGap_cents: books.reduce((n, book) => n + (book.integrity?.ownerGap_cents || 0), 0),
      issues: books.flatMap((book) => book.integrity?.issues || []),
    },
    expenses,
    sales: {
      rows: books.flatMap((book) => book.sales.rows),
      channelTotals: [...channel.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([channelName, value]) => ({ channel: channelName, ...value })),
      totals,
    },
    payouts: combinePayouts(books.map((book) => book.payouts), totals),
    inventory: combineInventory(first.inventory, last.inventory, books.map((book) => book.inventory)),
    received: books.flatMap((book) => book.received),
  };
}

function sumTotals(rows: BookTotals[]): BookTotals {
  const out = { ...rows[0] };
  for (const key of TOTAL_KEYS) out[key] = rows.reduce((n, row) => n + Number(row[key] || 0), 0);
  return out;
}

function sumProof(rows: MonthProof[]): MonthProof {
  const keys = Object.keys(rows[0]) as (keyof MonthProof)[];
  const out = { ...rows[0] };
  for (const key of keys) out[key] = rows.reduce((n, row) => n + Number(row[key] || 0), 0) as never;
  return out;
}

function combinePayouts(rows: PayoutsWorkbook[], totals: BookTotals): PayoutsWorkbook {
  const last = rows[rows.length - 1];
  const stores = new Map<string, StoreMoneyMonth>();
  rows.forEach((row, index) => {
    for (const store of row.stores) {
      const prev = stores.get(store.account);
      if (!prev) {
        stores.set(store.account, { ...store, transfers: [...store.transfers] });
        continue;
      }
      prev.money_in_cents += store.money_in_cents;
      prev.paid_to_bank_cents += store.paid_to_bank_cents;
      prev.transfers = prev.transfers.concat(store.transfers);
      if (index === rows.length - 1) {
        prev.end_balance_cents = store.end_balance_cents;
        prev.end_balance_estimated = store.end_balance_estimated;
      }
    }
  });
  const people = new Map<string, PayoutsWorkbook['commissions'][number]>();
  for (const row of rows) {
    for (const person of row.commissions) {
      const prev = people.get(person.person);
      if (!prev) people.set(person.person, { ...person });
      else {
        prev.earned_cents += person.earned_cents;
        prev.paid_cents += person.paid_cents;
      }
    }
  }
  for (const person of last.commissions) {
    const prev = people.get(person.person);
    if (prev) prev.owed_all_time_cents = person.owed_all_time_cents;
  }
  const commissions = [...people.values()];
  return {
    stores: [...stores.values()],
    bankPaidTotal_cents: rows.reduce((n, row) => n + row.bankPaidTotal_cents, 0),
    commissions,
    commission_total_cents: commissions.reduce((n, person) => n + person.earned_cents, 0),
    stillOwed_all_time_cents: last.stillOwed_all_time_cents,
    owner: {
      profit: totals.profit,
      commission: totals.commission,
      otherExpenses: totals.otherExpenses,
      ownerKeeps: totals.profit - totals.commission - totals.otherExpenses,
    },
  };
}

function combineInventory(first: InventorySummary, last: InventorySummary, all: InventorySummary[]): InventorySummary {
  const sum = (key: keyof InventorySummary) => all.reduce((n, row) => n + Number(row[key] || 0), 0);
  return {
    ...last,
    start_unit_count: first.start_unit_count,
    start_source: first.start_source,
    end_unit_count: last.end_unit_count,
    end_source: last.end_source,
    sold_units: sum('sold_units'),
    received_units: sum('received_units'),
    return_to_stock_units: sum('return_to_stock_units'),
    giveaway_units: sum('giveaway_units'),
    replacement_units: sum('replacement_units'),
    return_count: sum('return_count'),
    defective_units: sum('defective_units'),
    giveaways: all.flatMap((row) => row.giveaways || []),
    replacements: all.flatMap((row) => row.replacements || []),
    returns: all.flatMap((row) => row.returns || []),
    defective_moves: all.flatMap((row) => row.defective_moves || []),
    owner: last.owner ? {
      ...last.owner,
      value: last.owner.value ? {
        ...last.owner.value,
        start_units: first.owner?.value?.start_units,
        start_cost_cents: first.owner?.value?.start_cost_cents,
        start_floor_cents: first.owner?.value?.start_floor_cents,
        start_source: first.owner?.value?.start_source,
        start_note: first.owner?.value?.start_note,
      } : last.owner.value,
    } : last.owner,
  };
}

export function expenseMonthTotal(rows: ExpenseDisplayLine[]) {
  return rows.filter((row) => !row.excludeFromTotals).reduce((n, row) => n + row.amount_cents, 0);
}
