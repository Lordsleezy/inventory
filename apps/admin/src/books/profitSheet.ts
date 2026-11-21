import { pacificDay } from './pacificDay.ts';
import type { BooksWorkbook, Row, SalesLine } from './types';

function channelName(value: unknown) {
  const raw = String(value ?? '').toLowerCase();
  if (['floor', 'in_store', 'instore', 'store'].includes(raw)) return 'In-store';
  return ({ ebay: 'eBay', depop: 'Depop', website: 'Website', amazon: 'Amazon', tiktok: 'TikTok', mercari: 'Mercari', square: 'Square' } as Record<string, string>)[raw] || String(value ?? '');
}

export type ProfitLine = {
  label: string;
  /** Positive. Deductions are stored positive and written as a minus on the sheet. */
  cents: number;
  note: string;
  role: 'amount' | 'deduction' | 'info' | 'subtotal' | 'profit' | 'net' | 'reconcile';
  /** Shown instead of a dollar amount when the figure is a count or a label. */
  text?: string;
};

export type ReturnSheetRow = {
  date: string;
  sku: string;
  order: string;
  channel: string;
  status: string;
  what: string;
  refundCents: number;
  labelCents: number;
  /** Closed returns whose sale was voided. Open returns stay on the list and out of profit. */
  countsInProfit: boolean;
  inProfit: 'Yes' | 'Not yet' | 'No';
  shippingDeducted: 'Yes' | 'No';
  title: string;
};

const CLOSED = new Set(['refunded_no_return', 'dispositioned', 'closed']);
const CARD_NOT_IN_PROFIT = new Set(['in-store', 'website']);

export function returnCountsInProfit(row: Row): boolean {
  const status = String(row.status || '').toLowerCase();
  if (status === 'denied' || status === 'canceled' || status === 'cancelled') return false;
  if (CLOSED.has(status)) return true;
  if (row.disposition) return true;
  if (row.buyer_keeps_item === true || String(row.route_to || '') === 'buyer_keeps') return true;
  return false;
}

function returnIsOpen(row: Row): boolean {
  if (returnCountsInProfit(row)) return false;
  const status = String(row.status || '').toLowerCase();
  return status !== 'denied' && status !== 'canceled' && status !== 'cancelled';
}

function returnLabelCounts(row: Row): boolean {
  const status = String(row.status || '').toLowerCase();
  return status !== 'canceled' && status !== 'cancelled';
}

function cardCountsInProfit(row: SalesLine) {
  return !CARD_NOT_IN_PROFIT.has(String(row.channel || '').toLowerCase());
}

function dollars(cents: number) {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** This month's net after its own expenses. Earlier losses are not included. */
export function netAfterOwnExpenses(wb: BooksWorkbook): number {
  const line = profitStatement({
    ...wb,
    expenses: { ...wb.expenses, carried_loss_cents: 0 },
  }).find((row) => row.label === 'Net after expenses');
  return line?.cents || 0;
}

export function profitStatement(wb: BooksWorkbook): ProfitLine[] {
  const sales = wb.sales?.rows || [];
  const returns = wb.inventory?.returns || [];
  const refunds = returns.filter(returnCountsInProfit).reduce((sum, row) => sum + Number(row.refund_cents || 0), 0);
  const openRefunds = returns.filter(returnIsOpen).reduce((sum, row) => sum + Number(row.refund_cents || 0), 0);
  const returnShip = returns.filter(returnLabelCounts).reduce((sum, row) => sum + Number(row.label_cents || row.return_label_cents || 0), 0);

  const unpriced = sales.filter((row) => row.cost_cents == null);
  const sum = (rows: SalesLine[], pick: (row: SalesLine) => number) => rows.reduce((n, row) => n + pick(row), 0);
  const merchandise = sum(sales, (row) => row.price_cents || 0);
  const tax = sum(sales, (row) => row.tax_cents || 0);
  const buyerShip = sum(sales, (row) => row.buyer_shipping_cents || 0);
  const labels = sum(sales, (row) => row.label_cost_cents || 0);
  const fees = sum(sales, (row) => row.marketplace_fees_cents || 0);
  const card = sum(sales.filter(cardCountsInProfit), (row) => row.card_fees_cents || 0);
  const cardOnTop = sum(sales, (row) => row.card_fees_cents || 0) - card;
  const cost = sum(sales.filter((row) => row.cost_cents != null), (row) => row.cost_cents ?? 0);
  const leftOut = sum(unpriced, (row) => (row.price_cents || 0) + (row.buyer_shipping_cents || 0) - (row.label_cost_cents || 0) - (row.marketplace_fees_cents || 0) - (cardCountsInProfit(row) ? (row.card_fees_cents || 0) : 0));
  const columnProfit = sum(sales, (row) => row.profit_cents ?? 0);
  const built = merchandise + buyerShip - labels - fees - card - cost - leftOut;
  const gap = columnProfit - built;

  const other = Number(wb.expenses?.otherExpenses_cents || 0);
  const expenseTotal = Number(wb.expenses?.total_cents || 0);
  const bonus = Number(wb.expenses?.bonus_cents || 0);
  const giveRows = wb.inventory?.giveaways || [];
  let givenAway = 0;
  let giveUnknown = 0;
  for (const row of giveRows) {
    const cost = row.cost_cents;
    if (cost == null || cost === '' || !Number.isFinite(Number(cost))) giveUnknown += 1;
    else givenAway += Number(cost);
  }
  const replacements = (wb.inventory?.replacements || []).reduce((sum, row) => sum + Number(row.extra_cost_cents || 0), 0);
  const salesProfit = columnProfit;
  const carried = (wb.expenses?.rows || [])
    .filter((row) => row.carried && !row.excludeFromTotals)
    .reduce((sum, row) => sum + row.amount_cents, 0);
  const bonusRows = (wb.expenses?.rows || []).filter((row) => !row.excludeFromTotals && String(row.category || '').toLowerCase() === 'bonus');
  const bonusDetail = wb.expenses?.bonus_lines || [];
  const bonusPay = bonusDetail.length
    ? bonusDetail.reduce((sum, row) => sum + row.cents, 0)
    : (bonusRows.length ? bonusRows.reduce((sum, row) => sum + row.amount_cents, 0) : bonus);
  const staffRows = (wb.payouts?.commissions || []).filter((row) => row.role === 'staff');
  // Floor's number: the commission saved on each sale for Paul and Jacob, plus bonuses entered on Expenses.
  const saleCommission = staffRows.length
    ? staffRows.reduce((sum, row) => sum + row.earned_cents, 0)
    : sum(sales, (row) => row.cost_cents == null ? 0 : (row.commission_cents || 0));
  const commission = saleCommission;
  const ownerProfit = salesProfit - commission - bonusPay;
  const carriedLoss = Math.max(0, Number(wb.expenses?.carried_loss_cents || 0));
  const totalExpenses = other + returnShip + givenAway + replacements + carriedLoss;
  const netAfterExpenses = ownerProfit - totalExpenses;
  const lines: ProfitLine[] = [
    {
      label: 'Gross merchandise sales',
      cents: merchandise + refunds,
      note: 'Sale prices still on the Sales tab, plus completed refunds so the next line can take them back out.',
      role: 'amount',
    },
    {
      label: 'Completed refunds',
      cents: refunds,
      note: 'Closed returns. Those sales are already off the Sales tab, so this only reverses the add-back above. Open returns are not in this number.',
      role: 'deduction',
    },
    {
      label: 'Net merchandise sales',
      cents: merchandise,
      note: 'Equals the Sale price column on the Sales tab.',
      role: 'subtotal',
    },
    {
      label: 'Customer-paid shipping',
      cents: buyerShip,
      note: 'Sales tab, Buyer paid shipping column. Included in sales contribution.',
      role: 'amount',
    },
    {
      label: 'Cost of goods sold',
      cents: cost,
      note: 'Sales tab, Item cost column. Each amount is the cost saved on that item in Floor. A blank cost is not treated as $0.',
      role: 'deduction',
    },
    {
      label: 'Marketplace fees',
      cents: fees,
      note: 'Sales tab. Includes promoted listing fees. When eBay bills those with no order number, they are split across that period\'s eBay sales by sale price and are not deducted again as an expense. The Fees, card, label column is marketplace fees plus card fees plus the outbound label. Do not add that column on top of these lines.',
      role: 'deduction',
    },
    {
      label: 'Card fees',
      cents: card,
      note: 'Card fees that come out of the sale. In-store fees the customer paid on top are in the box below.',
      role: 'deduction',
    },
    {
      label: 'Outbound shipping',
      cents: labels,
      note: 'Sales tab, Shipping label (we paid) column. Labels to ship the order out.',
      role: 'deduction',
    },
  ];
  if (unpriced.length) {
    lines.push({
      label: 'Sales left out, cost missing',
      cents: leftOut,
      note: `${unpriced.length} of ${sales.length} sales have no item cost. Their price, shipping, and fees are in the lines above, and this pulls that whole sale out. No cost was estimated.`,
      role: 'deduction',
    });
  }
  if (gap) {
    lines.push({
      label: 'Match the Sales tab',
      cents: Math.abs(gap),
      note: `The lines above were ${dollars(gap)} off the Profit column on Sales. This makes sales contribution match that column. The difference is unresolved beyond that.`,
      role: gap > 0 ? 'amount' : 'deduction',
    });
  }
  lines.push(
    {
      label: 'Sales contribution',
      cents: salesProfit,
      note: 'Equals the Profit column on the Sales tab, which uses the same sale profit as Floor. Commissions are the amounts Floor saved on these sales. The owner keeps the rest. Expenses come off after that.',
      role: 'subtotal',
    },
    {
      label: 'Commissions',
      cents: commission,
      note: saleCommission
        ? `${dollars(saleCommission)} is the commission Floor saved on these sales for Paul and Jacob. Bonuses are the next line.`
        : 'No sale commission was saved on these sales. Bonuses are the next line.',
      role: 'deduction',
    },
    {
      label: 'Bonuses',
      cents: bonusPay,
      note: bonusDetail.length
        ? bonusDetail.map((row) => row.note).join(' ')
        : (bonusRows.length
          ? bonusRows.map((row) => `${row.date ? `${row.date} ` : ''}${row.title} ${dollars(row.amount_cents)}`).join('; ') + '. Entered on Expenses. Not inside the commission line above.'
          : (bonusPay ? `${dollars(bonusPay)} entered on Expenses. Not inside the commission line above.` : 'No bonus entered this month.')),
      role: 'deduction',
    },
  );
  if (giveUnknown && !givenAway) {
    lines.push({
      label: 'Giveaways missing a cost',
      cents: 0,
      text: `${giveUnknown} items`,
      note: `${giveUnknown} items given away have no recorded cost. They are not deducted, and no cost was estimated.`,
      role: 'info',
    });
  }
  const expenseParts = [
    other ? `${dollars(other)} entered as expenses` : '',
    carriedLoss ? `${dollars(carriedLoss)} is the net loss from earlier months that later profit has not covered` : '',
    carried ? `${dollars(carried)} of the expenses on the Expenses tab is still unpaid from an earlier month` : '',
    !carriedLoss && !carried ? 'Nothing from an earlier month is still unpaid' : '',
    returnShip ? `${dollars(returnShip)} return shipping` : '',
    givenAway ? `${dollars(givenAway)} cost of items given away` : '',
    replacements ? `${dollars(replacements)} replacement cost` : '',
    expenseTotal ? `The Expenses tab grand total is ${dollars(expenseTotal)}. Amounts already inside the sales and return lines above are not in this total again.` : '',
  ].filter(Boolean);
  lines.push({
    label: 'Owner profit',
    cents: ownerProfit,
    note: 'Profit on sales minus the commissions and bonuses above. Expenses are not taken out of this. It is not cash in the bank.',
    role: 'profit',
  });
  lines.push({
    label: 'Total expenses',
    cents: totalExpenses,
    note: expenseParts.join('. ') + '.',
    role: 'deduction',
  });
  lines.push({
    label: 'Net after expenses',
    cents: netAfterExpenses,
    note: 'Owner profit minus the expenses above, including anything still unpaid from an earlier month. It is not cash in the bank.',
    role: 'net',
  });
  lines.push(
    {
      label: 'Sales tax collected',
      cents: tax,
      note: 'Collected for the state on top of the sale price. It is not inside net merchandise sales and it is not profit. The Sales tax return tab is the filing worksheet. Nothing here has been sent to CDTFA.',
      role: 'info',
    },
  );
  if (cardOnTop) {
    lines.push({
      label: 'Card fees the customer paid',
      cents: cardOnTop,
      note: 'In-store. The customer paid this on top of the price, so it is not a cost.',
      role: 'info',
    });
  }
  if (openRefunds) {
    lines.push({
      label: 'Open returns',
      cents: openRefunds,
      note: 'Requested or still in progress. Not deducted. They come out of profit when the sale is voided. An open return is not counted as back in stock.',
      role: 'info',
    });
  }
  return lines;
}

function statusLabel(status: unknown): string {
  const key = String(status || '').toLowerCase();
  const named: Record<string, string> = {
    requested: 'Requested',
    approved: 'Approved',
    in_transit: 'On the way back',
    received: 'Received',
    inspected: 'Inspected',
    dispositioned: 'Closed',
    closed: 'Closed',
    refunded_no_return: 'Refunded, buyer kept it',
    denied: 'Denied',
    canceled: 'Canceled',
    cancelled: 'Canceled',
  };
  return named[key] || key.replaceAll('_', ' ');
}

function whatHappened(row: Row): string {
  if (row.buyer_keeps_item === true || String(row.route_to || '') === 'buyer_keeps') return 'Buyer kept it';
  const disposition = String(row.disposition || '').toLowerCase();
  const named: Record<string, string> = {
    relist: 'Back to stock',
    downgrade_channel: 'Moved to another channel',
    bundle_lot: 'Bundled',
    write_off: 'Written off',
    supplier_credit: 'Supplier credit',
    keep_buyer: 'Buyer kept it',
  };
  if (named[disposition]) return named[disposition];
  if (String(row.route_to || '') === 'supplier') return 'Sent to supplier';
  if (String(row.route_to || '') === 'garage') return 'Back in the garage';
  if (returnIsOpen(row)) return 'Not confirmed back in stock';
  return '';
}

function inProfitLabel(row: Row): ReturnSheetRow['inProfit'] {
  if (returnCountsInProfit(row)) return 'Yes';
  if (returnIsOpen(row)) return 'Not yet';
  return 'No';
}

export function returnSheetRows(rows: Row[], titles: Map<string, string> = new Map()): ReturnSheetRow[] {
  return rows.map((row) => ({
    date: pacificDay(row.date || row.created_at),
    sku: String(row.sku || ''),
    title: titles.get(String(row.sku || '')) || String(row.title || ''),
    order: String(row.order_id || row.external_order_id || ''),
    channel: channelName(row.channel),
    status: statusLabel(row.status),
    what: whatHappened(row),
    refundCents: Number(row.refund_cents || 0),
    labelCents: Number(row.label_cents || row.return_label_cents || 0),
    countsInProfit: returnCountsInProfit(row),
    inProfit: inProfitLabel(row),
    shippingDeducted: returnLabelCounts(row) && Number(row.label_cents || row.return_label_cents || 0) > 0 ? 'Yes' : 'No',
  }));
}
