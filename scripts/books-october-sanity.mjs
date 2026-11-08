/**
 * October 2026 Books sanity (legacy summary tiles logic).
 * Run against local DB after migrations: node scripts/books-october-sanity.mjs
 * Targets: sales $8236.91, COGS $2091.50, fees+labels $806.45, commission $1766.11, profit $5501.09
 */
import pg from 'pg';

const TARGETS = {
  sales_cents: 823691,
  cost_cents: 209150,
  fees_labels_cents: 80645,
  commission_cents: 176611,
  profit_cents: 550109,
};

function totalsFromReport(report) {
  const sales = report.sales || [];
  const fees = (report.fees || []).reduce((n, f) => n + Number(f.amount_cents || 0), 0);
  const labelOnSales = sales.reduce((n, r) => n + Number(r.ship_cost_cents || 0), 0);
  return {
    sales_cents: sales.reduce((n, r) => n + Number(r.price_cents || 0) + Number(r.shipping_cents || 0), 0),
    cost_cents: sales.reduce((n, r) => n + Number(r.cost_cents || 0), 0),
    fees_labels_cents: fees + labelOnSales,
    commission_cents: (report.payouts || []).reduce((n, r) => n + Number(r.amount_cents || 0), 0),
    profit_cents: sales.reduce((n, r) => n + Number(r.profit_cents || 0), 0),
  };
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('Set DATABASE_URL to compare live October 2026. Expected cents:', TARGETS);
  process.exit(0);
}

const db = new pg.Client({ connectionString: url });
await db.connect();
const { rows } = await db.query(
  `select id from public.books_periods where period_type = 'month' and period_start = '2026-10-01' limit 1`,
);
if (!rows[0]) {
  console.error('October 2026 period not found');
  process.exit(1);
}
const { rows: rpt } = await db.query(`select public.portal_books_report($1) as report`, [rows[0].id]);
const got = totalsFromReport(rpt[0].report);
for (const key of Object.keys(TARGETS)) {
  const ok = got[key] === TARGETS[key];
  console.log(key, got[key], ok ? 'OK' : `DIFF (target ${TARGETS[key]}, delta ${got[key] - TARGETS[key]})`);
}
await db.end();
