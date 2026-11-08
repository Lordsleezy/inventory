import type { BooksWorkbook, Report, SalesLine } from './types';
import type { PersonBalance } from './payoutLedger';

export type BooksIntegrityIssue = {
  kind: 'commission' | 'owner' | 'owed_paul' | 'owed_jacob' | 'in_store_fee';
  message: string;
  cents?: number;
  saleId?: string;
  sku?: string;
};

export type BooksIntegrity = {
  ok: boolean;
  commissionGap_cents: number;
  ownerGap_cents: number;
  owedPaulGap_cents: number | null;
  owedJacobGap_cents: number | null;
  issues: BooksIntegrityIssue[];
};

function sumLineCommission(rows: SalesLine[]) {
  let sum = 0;
  for (const s of rows) sum += s.commission_cents ?? 0;
  return sum;
}

function sumTicketOwnerFromLines(rows: SalesLine[]) {
  let sum = 0;
  for (const s of rows) {
    if (s.profit_cents == null || s.commission_cents == null) continue;
    sum += s.profit_cents - s.commission_cents;
  }
  return sum;
}

export function verifyBooksIntegrity(
  workbook: BooksWorkbook,
  report: Report | null,
  ledger?: { paulOwed: number; jacobOwed: number },
): BooksIntegrity {
  const totals = workbook.sales.totals;
  const { proof } = workbook;
  const lineComm = sumLineCommission(workbook.sales.rows);
  const commissionGap = lineComm - totals.commission;
  const ownerFromLines = sumTicketOwnerFromLines(workbook.sales.rows);
  const ownerGap = ownerFromLines - proof.ownerBeforeOther;

  const issues: BooksIntegrityIssue[] = [];
  if (commissionGap !== 0) {
    issues.push({
      kind: 'commission',
      message: `Sales sheet commission ${(lineComm / 100).toFixed(2)} vs hub ${(totals.commission / 100).toFixed(2)}`,
      cents: commissionGap,
    });
  }
  if (ownerGap !== 0) {
    issues.push({
      kind: 'owner',
      message: `Owner before other ${(proof.ownerBeforeOther / 100).toFixed(2)} vs line rollup ${(ownerFromLines / 100).toFixed(2)}`,
      cents: ownerGap,
    });
  }

  if (report) {
    const legacy = (report.payouts || []).reduce((n, r) => n + Number(r.amount_cents || 0), 0);
    if (legacy !== totals.commission) {
      issues.push({
        kind: 'commission',
        message: `Legacy report.payouts ${(legacy / 100).toFixed(2)} (not used) vs tickets ${(totals.commission / 100).toFixed(2)}`,
        cents: legacy - totals.commission,
      });
    }
  }

  let owedPaulGap: number | null = null;
  let owedJacobGap: number | null = null;
  if (ledger) {
    const paulRow = workbook.payouts.commissions.find((c) => c.person === 'Paul');
    const jacobRow = workbook.payouts.commissions.find((c) => c.person === 'Jacob');
    if (paulRow) {
      owedPaulGap = paulRow.owed_all_time_cents - ledger.paulOwed;
      if (owedPaulGap !== 0) {
        issues.push({
          kind: 'owed_paul',
          message: `Paul owed: Books ${(paulRow.owed_all_time_cents / 100).toFixed(2)} vs Payouts tab ${(ledger.paulOwed / 100).toFixed(2)}`,
          cents: owedPaulGap,
        });
      }
    }
    if (jacobRow) {
      owedJacobGap = jacobRow.owed_all_time_cents - ledger.jacobOwed;
      if (owedJacobGap !== 0) {
        issues.push({
          kind: 'owed_jacob',
          message: `Jacob owed: Books ${(jacobRow.owed_all_time_cents / 100).toFixed(2)} vs Payouts tab ${(ledger.jacobOwed / 100).toFixed(2)}`,
          cents: owedJacobGap,
        });
      }
    }
  }

  for (const a of workbook.audit) {
    issues.push({ kind: 'in_store_fee', message: a.message, saleId: a.ticketKey });
  }

  const ticketOk = commissionGap === 0 && ownerGap === 0
    && (owedPaulGap === null || owedPaulGap === 0)
    && (owedJacobGap === null || owedJacobGap === 0);

  return {
    ok: ticketOk && workbook.audit.length === 0,
    commissionGap_cents: commissionGap,
    ownerGap_cents: ownerGap,
    owedPaulGap_cents: owedPaulGap,
    owedJacobGap_cents: owedJacobGap,
    issues,
  };
}

export function ledgerOwedFromBalances(
  balances: PersonBalance[],
  paulIds: string[],
  jacobIds: string[],
): { paulOwed: number; jacobOwed: number } {
  const pick = (ids: string[]) => ids.reduce((n, id) => n + (balances.find((b) => b.user_id === id)?.commissionOwed || 0), 0);
  return { paulOwed: pick(paulIds), jacobOwed: pick(jacobIds) };
}
