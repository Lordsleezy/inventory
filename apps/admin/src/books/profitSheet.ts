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
  role: 'amount' | 'deduction' | 'info' | 'subtotal' | 'profit';
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
  const leftOut = sum(unpriced, (row) => row.price_cents + row.buyer_shipping_cents - row.label_cost_cents - row.marketplace_fees_cents - (cardCountsInProfit(row) ? row.card_fees_cents : 0));
  const columnProfit = sum(sales, (row) => row.profit_cents ?? 0);
  const built = merchandise + buyerShip - labels - fees - card - cost - leftOut;
  const gap = columnProfit - built;

  const other = Number(wb.expenses?.otherExpenses_cents || 0);
  const expenseTotal = Number(wb.expenses?.total_cents || 0);
  const commission = Number(wb.sales?.totals?.commission || wb.payouts?.owner?.commission || 0);
  const givenAway = (wb.inventory?.giveaways || []).reduce((sum, row) => sum + Number(row.cost_cents || 0), 0);
  const replacements = (wb.inventory?.replacements || []).reduce((sum, row) => sum + Number(row.extra_cost_cents || 0), 0);
  const salesProfit = columnProfit;
  const profitCents = salesProfit - returnShip - other - commission - givenAway - replacements;
  const ownerKeeps = wb.payouts?.owner?.ownerKeeps;

  const lines: ProfitLine[] = [
    {
      label: 'Sale prices',
      cents: merchandise + refunds,
      note: refunds
        ? `Sales tab, Sale price column, adds up to ${dollars(merchandise)}. Refunded orders are not on that tab, so ${dollars(refunds)} is added back here and taken out on Returns / refunds.`
        : 'Sales tab, Sale price column.',
      role: 'amount',
    },
    {
      label: 'Shipping customers paid',
      cents: buyerShip,
      note: 'Sales tab, Buyer paid shipping column. Included in profit.',
      role: 'amount',
    },
    {
      label: 'Sales tax',
      cents: tax,
      note: 'Sales tab, Sales tax column, and the Sales tax return tab. Collected for the state. It is not part of the sale price and it is not profit.',
      role: 'info',
    },
    {
      label: 'Marketplace fees',
      cents: fees,
      note: 'Sales tab. The Fees, card, label column is this plus card fees plus the shipping label. Do not add that column on top of these lines.',
      role: 'deduction',
    },
    {
      label: 'Card fees',
      cents: card,
      note: 'Sales tab, Card fee column, where the fee comes out of the sale.',
      role: 'deduction',
    },
  ];
  if (cardOnTop) {
    lines.push({
      label: 'Card fees the customer paid',
      cents: cardOnTop,
      note: 'In-store. The customer paid this on top of the price, so it is not a cost and it is not in profit.',
      role: 'info',
    });
  }
  lines.push(
    {
      label: 'Shipping we paid',
      cents: labels,
      note: 'Sales tab, Shipping label (we paid) column.',
      role: 'deduction',
    },
    {
      label: 'Item cost',
      cents: cost,
      note: 'Sales tab, Item cost column.',
      role: 'deduction',
    },
  );
  if (unpriced.length) {
    lines.push({
      label: 'Sales with no item cost',
      cents: leftOut,
      note: `${unpriced.length} sale${unpriced.length === 1 ? '' : 's'} still need a cost. Their price, shipping, and fees are in the lines above, and this pulls them back out until the cost is filled in.`,
      role: 'deduction',
    });
  }
  lines.push({
    label: 'Returns / refunds',
    cents: refunds,
    note: 'Returns tab. These orders are already off the Sales tab, so this only reverses the amount added back into Sale prices. Open returns are not in this number.',
    role: 'deduction',
  });
  if (openRefunds) {
    lines.push({
      label: 'Open returns',
      cents: openRefunds,
      note: 'Returns tab. Not taken out of profit yet. They come out when the sale is voided.',
      role: 'info',
    });
  }
  if (gap) {
    lines.push({
      label: 'Match the Sales tab',
      cents: Math.abs(gap),
      note: `The lines above were ${dollars(gap)} off the Profit column on Sales. This makes the next line match that column.`,
      role: gap > 0 ? 'amount' : 'deduction',
    });
  }
  lines.push(
    {
      label: 'Profit on sales',
      cents: salesProfit,
      note: 'Equals the Profit column on the Sales tab, and the Profit line on Payouts.',
      role: 'subtotal',
    },
    {
      label: 'Return shipping',
      cents: returnShip,
      note: 'Returns tab, Return shipping column. The Sales profit does not subtract this, so it comes out here.',
      role: 'deduction',
    },
    {
      label: 'Other expenses',
      cents: other,
      note: expenseTotal
        ? `Expenses tab grand total is ${dollars(expenseTotal)}. ${dollars(expenseTotal - other)} of that is fees and labels already taken out above, including return labels. This line is the rest.`
        : 'Expenses tab. The part that is not already on a sale.',
      role: 'deduction',
    },
    {
      label: 'Commissions',
      cents: commission,
      note: 'Payouts tab, commissions for this period.',
      role: 'deduction',
    },
  );
  if (givenAway) {
    lines.push({
      label: 'Given away',
      cents: givenAway,
      note: 'Inventory tab. Cost of items given away. Not on a sale.',
      role: 'deduction',
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
  const ownerNote = ownerKeeps == null
    ? ''
    : ` Payouts owner keeps is ${dollars(ownerKeeps)}. That number does not subtract return shipping${givenAway ? ' or items given away' : ''}.`;
  lines.push({
    label: 'Profit',
    cents: profitCents,
    note: `Profit on sales − return shipping − other expenses − commissions${givenAway ? ' − given away' : ''}${replacements ? ' − replacement cost' : ''}.${ownerNote}`,
    role: 'profit',
  });
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
  return '';
}

function inProfitLabel(row: Row): ReturnSheetRow['inProfit'] {
  if (returnCountsInProfit(row)) return 'Yes';
  if (returnIsOpen(row)) return 'Not yet';
  return 'No';
}

export function returnSheetRows(rows: Row[]): ReturnSheetRow[] {
  return rows.map((row) => ({
    date: String(row.date || row.created_at || '').slice(0, 10),
    sku: String(row.sku || ''),
    order: String(row.order_id || row.external_order_id || ''),
    channel: channelName(row.channel),
    status: statusLabel(row.status),
    what: whatHappened(row),
    refundCents: Number(row.refund_cents || 0),
    labelCents: Number(row.label_cents || row.return_label_cents || 0),
    countsInProfit: returnCountsInProfit(row),
    inProfit: inProfitLabel(row),
  }));
}
