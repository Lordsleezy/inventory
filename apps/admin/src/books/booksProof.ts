import type { BooksWorkbook, Report, SalesLine } from './types';
import type { PersonBalance } from './payoutLedger';

export type BooksIntegrityIssue = {
  kind: 'commission' | 'owner' | 'owed_paul' | 'owed_jacob' | 'in_store_fee' | 'unmatched_label';
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

function dollars(cents: number) {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
      message: `Commissions: sale rows add up to ${dollars(lineComm)} but the summary says ${dollars(totals.commission)} (${dollars(Math.abs(commissionGap))} off)`,
      cents: commissionGap,
    });
  }
  if (ownerGap !== 0) {
    issues.push({
      kind: 'owner',
      message: `Owner's share before other expenses: sale rows add up to ${dollars(ownerFromLines)} but the summary says ${dollars(proof.ownerBeforeOther)} (${dollars(Math.abs(ownerGap))} off)`,
      cents: ownerGap,
    });
  }

  if (report) {
    const legacy = (report.payouts || []).reduce((n, r) => n + Number(r.amount_cents || 0), 0);
    if (legacy !== totals.commission) {
      console.info(`Books legacy report.payouts ${dollars(legacy)} is not used. Ticket commissions are ${dollars(totals.commission)}.`);
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
          message: `Paul's balance: Books says ${dollars(paulRow.owed_all_time_cents)} but Payouts says ${dollars(ledger.paulOwed)} (${dollars(Math.abs(owedPaulGap))} off)`,
          cents: owedPaulGap,
        });
      }
    }
    if (jacobRow) {
      owedJacobGap = jacobRow.owed_all_time_cents - ledger.jacobOwed;
      if (owedJacobGap !== 0) {
        issues.push({
          kind: 'owed_jacob',
          message: `Jacob's balance: Books says ${dollars(jacobRow.owed_all_time_cents)} but Payouts says ${dollars(ledger.jacobOwed)} (${dollars(Math.abs(owedJacobGap))} off)`,
          cents: owedJacobGap,
        });
      }
    }
  }

  for (const a of workbook.audit) {
    issues.push({ kind: 'in_store_fee', message: a.message, saleId: a.ticketKey });
  }

  const unmatched = report?.books_unmatched_labels || [];
  for (const u of unmatched) {
    issues.push({
      kind: 'unmatched_label',
      message: `Shipping label not matched to a sale: ${u.title}, ${u.date}, ${dollars(u.amount_cents)}`,
      cents: u.amount_cents,
      saleId: u.id,
    });
  }

  const ticketOk = commissionGap === 0 && ownerGap === 0
    && (owedPaulGap === null || owedPaulGap === 0)
    && (owedJacobGap === null || owedJacobGap === 0);

  return {
    ok: ticketOk && workbook.audit.length === 0 && unmatched.length === 0,
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
  // The Payouts card says "owed" for the full balance (commission still unpaid plus reimbursements).
  const pick = (ids: string[]) => ids.reduce((n, id) => n + (balances.find((b) => b.user_id === id)?.balance || 0), 0);
  return { paulOwed: pick(paulIds), jacobOwed: pick(jacobIds) };
}
