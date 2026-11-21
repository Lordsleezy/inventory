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
  role: 'amount' | 'deduction' | 'info' | 'subtotal' | 'profit' | 'reconcile';
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
  const saleCommission = Number(wb.sales?.totals?.commission || 0);
  const commission = saleCommission + bonus;
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
  const profitCents = salesProfit - returnShip - other - commission - givenAway - replacements;
  const ownerKeeps = wb.payouts?.owner?.ownerKeeps;

  const namedCommission = (wb.payouts?.commissions || []).filter((row) => row.role === 'staff').reduce((sum, row) => sum + row.earned_cents, 0);
  const commissionGap = wb.payouts ? saleCommission - namedCommission : 0;
  const ownerFormula = salesProfit - commission - other;
  const staffPct = salesProfit > 0 ? Math.round((1000 * saleCommission) / salesProfit) / 10 : null;
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
      note: 'Sales tab, Item cost column, for sales that have a cost. A blank cost is not treated as $0.',
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
      note: 'Equals the Profit column on the Sales tab. This is profit on the sales that have an item cost, before return shipping, operating expenses, and commissions.',
      role: 'subtotal',
    },
    {
      label: 'Return shipping',
      cents: returnShip,
      note: 'Returns tab. Labels we paid to get items back, except canceled returns. Sales contribution does not subtract this.',
      role: 'deduction',
    },
    {
      label: 'Operating expenses',
      cents: other,
      note: expenseTotal
        ? `Expenses tab grand total is ${dollars(expenseTotal)}. ${dollars(Math.max(0, expenseTotal - other - bonus))} of that is already in the sales and return lines above.${bonus ? ` ${dollars(bonus)} is in the commission line.` : ''} This line is the rest.`
        : 'Expenses that are not already on a sale or a return label.',
      role: 'deduction',
    },
    {
      label: 'Commissions',
      cents: commission,
      note: [
        'Staff commission is 30% of the profit on each sale after marketplace fees. The owner keeps the other 70% of that profit. The other costs on this page come out of the owner\'s share.',
        staffPct != null && Math.abs(staffPct - 30) >= 1
          ? `On this period the sale commissions are ${staffPct}% of the profit on sales.`
          : '',
        bonus ? `This line includes ${dollars(bonus)} of bonuses. A bonus is not deducted again as an expense.` : '',
        commissionGap
          ? `Paul and Jacob's sale commissions add to ${dollars(namedCommission)}. ${dollars(commissionGap)} is on a commission rule this export does not name. It is not a plug, and it is not deducted twice.`
          : 'The Payouts tab lists Paul and Jacob.',
      ].filter(Boolean).join(' '),
      role: 'deduction',
    },
  );
  if (givenAway) {
    lines.push({
      label: 'Given away',
      cents: givenAway,
      note: 'Inventory tab. Recorded cost of items given away. Not on a sale.'
        + (giveUnknown ? ` ${giveUnknown} more have no cost and are not in this amount. Nothing was estimated.` : ''),
      role: 'deduction',
    });
  }
  if (giveUnknown && !givenAway) {
    lines.push({
      label: 'Giveaways missing a cost',
      cents: 0,
      text: `${giveUnknown} items`,
      note: `${giveUnknown} items given away have no recorded cost. They are not deducted, and no cost was estimated.`,
      role: 'info',
    });
  }
  if (replacements) {
    lines.push({
      label: 'Replacement cost',
      cents: replacements,
      note: 'Inventory tab. Extra cost of replacements. Not on a sale.',
      role: 'deduction',
    });
  }
  lines.push({
    label: 'Owner keeps',
    cents: profitCents,
    note: 'What is left after the costs above goes to the owner. There is no separate business profit. It is not cash in the bank.',
    role: 'profit',
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
  if (ownerKeeps != null && ownerKeeps !== ownerFormula) {
    lines.push({
      label: 'Owner keeps does not match',
      cents: ownerKeeps - ownerFormula,
      note: 'The stored owner figure does not equal sales contribution minus commissions minus operating expenses. The difference is unresolved.',
      role: 'reconcile',
    });
  }
  if (wb.payouts) {
    lines.push({
      label: 'Commission schedule vs profit',
      cents: commissionGap,
      note: commissionGap
        ? `Paul and Jacob earned ${dollars(namedCommission)} on sales. Profit deducts ${dollars(saleCommission)} of sale commissions${bonus ? ` plus ${dollars(bonus)} of bonuses` : ''}. The ${dollars(commissionGap)} difference is unresolved: this export only names those two people.`
        : bonus
          ? `Paul and Jacob's sale commissions add up. This line also includes ${dollars(bonus)} of bonuses.`
          : 'Paul and Jacob\'s earned commissions add up to the sale commissions deducted in profit.',
      role: 'reconcile',
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
