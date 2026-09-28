type Report = {
  id: string;
  period_type: 'daily' | 'weekly'; period_start: string; period_end: string;
  summary: { sales_cents: number; card_fee_cents: number; tax_cents: number };
  expenses: { description: string; category: string; amount_cents: number; needs_reimbursement?: boolean; employee_id?: string }[];
  notes: string; created_at: string; created_by: string; edited_at: string; edited_by: string;
};
type Sale = { sold_at: string; sku: string; title: string; price_cents: number; tax_cents: number; card_fee_cents: number };
const currency = '$#,##0.00;[Red]($#,##0.00)';
const dollars = (cents: number) => cents / 100;
const finalDay = (exclusiveEnd: string) => {
  const date = new Date(`${exclusiveEnd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};
const dateTime = (value: string) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
}).format(new Date(value));

export async function downloadReportWorkbook(
  reports: Report[], getSales: (report: Report) => Promise<Sale[]>,
  personName: (id: string) => string, all: boolean
) {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  book.creator = 'Floor Admin';
  const selected = all ? reports : reports.slice(0, 1);
  const sales = await Promise.all(selected.map(getSales));

  if (all) {
    const sheet = book.addWorksheet('Summary');
    sheet.columns = [
      { header: 'Period', key: 'period', width: 14 }, { header: 'Start', key: 'start', width: 15 },
      { header: 'End', key: 'end', width: 15 }, { header: 'Sales', key: 'sales', width: 16 },
      { header: 'Card fees', key: 'fees', width: 16 }, { header: 'Tax', key: 'tax', width: 16 },
      { header: 'Total expenses', key: 'expenses', width: 18 }, { header: 'Net', key: 'net', width: 16 }
    ];
    sheet.getRow(1).font = { bold: true };
    for (const report of selected) {
      const expenses = report.expenses.reduce((n, x) => n + x.amount_cents, 0);
      const row = sheet.addRow({ period: report.period_type, start: report.period_start,
        end: finalDay(report.period_end), sales: dollars(report.summary.sales_cents),
        fees: dollars(report.summary.card_fee_cents), tax: dollars(report.summary.tax_cents),
        expenses: dollars(expenses), net: dollars(report.summary.sales_cents - expenses) });
      for (const col of [4, 5, 6, 7, 8]) row.getCell(col).numFmt = currency;
    }
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  selected.forEach((report, index) => {
    const sheet = book.addWorksheet(`${report.period_type === 'daily' ? 'Daily' : 'Weekly'} ${report.period_start}`);
    sheet.columns = [{ width: 24 }, { width: 18 }, { width: 38 }, { width: 18 }, { width: 18 }, { width: 18 }];
    sheet.addRow(['Open Box Industries', `${report.period_type} report`]);
    sheet.getRow(1).font = { bold: true, size: 14 };
    sheet.addRow(['Period start', report.period_start, 'Period end', finalDay(report.period_end)]);
    const totals = [
      ['Sales', report.summary.sales_cents], ['Card fees', report.summary.card_fee_cents],
      ['Tax', report.summary.tax_cents]
    ] as const;
    for (const [label, cents] of totals) {
      const row = sheet.addRow([label, dollars(cents)]);
      row.getCell(2).numFmt = currency;
    }
    sheet.addRow([]);
    sheet.addRow(['Individual sales']);
    const saleHeader = sheet.addRow(['Date / time (Pacific)', 'SKU', 'Item', 'Merchandise', 'Tax', 'Card fee']);
    saleHeader.font = { bold: true };
    for (const sale of sales[index]) {
      const row = sheet.addRow([dateTime(sale.sold_at), sale.sku, sale.title,
        dollars(sale.price_cents), dollars(sale.tax_cents), dollars(sale.card_fee_cents)]);
      for (const col of [4, 5, 6]) row.getCell(col).numFmt = currency;
    }
    const saleTotal = sheet.addRow(['Sales totals', '', '', dollars(report.summary.sales_cents),
      dollars(report.summary.tax_cents), dollars(report.summary.card_fee_cents)]);
    saleTotal.font = { bold: true };
    for (const col of [4, 5, 6]) saleTotal.getCell(col).numFmt = currency;
    sheet.addRow([]);
    sheet.addRow(['Expenses']);
    const expenseHeader = sheet.addRow(['Description', 'Category', 'Amount', 'Needs reimbursement', 'Who']);
    expenseHeader.font = { bold: true };
    for (const expense of report.expenses) {
      const row = sheet.addRow([expense.description, expense.category, dollars(expense.amount_cents),
        expense.needs_reimbursement ? 'Yes' : 'No',
        expense.needs_reimbursement && expense.employee_id ? personName(expense.employee_id) : '']);
      row.getCell(3).numFmt = currency;
    }
    const expenses = report.expenses.reduce((n, x) => n + x.amount_cents, 0);
    const expenseTotal = sheet.addRow(['Total expenses', '', dollars(expenses)]);
    expenseTotal.font = { bold: true }; expenseTotal.getCell(3).numFmt = currency;
    const net = sheet.addRow(['Net merchandise after expenses', '', dollars(report.summary.sales_cents - expenses)]);
    net.font = { bold: true }; net.getCell(3).numFmt = currency;
    sheet.addRow([]);
    sheet.addRow(['Notes', report.notes]);
    sheet.addRow(['Submitted by', personName(report.created_by), dateTime(report.created_at)]);
    sheet.addRow(['Last edited by', personName(report.edited_by), dateTime(report.edited_at)]);
  });

  const buffer = await book.xlsx.writeBuffer();
  const blob = new Blob([buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = all ? `OpenBox-Reports-All-${new Date().toISOString().slice(0, 10)}.xlsx`
    : `OpenBox-Report-${selected[0].period_start}-${selected[0].period_type}.xlsx`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
