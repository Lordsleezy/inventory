import type { ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReportTab } from './navigation';
import { ChannelReportPage } from './ChannelReportPage';
import { TaxReportPage } from './TaxReportPage';

type Props = {
  client: SupabaseClient;
  money: (n: number) => string;
  tab: ReportTab;
  onTab: (t: ReportTab) => void;
  closeouts: ReactNode;
  expenses: ReactNode;
  payouts: ReactNode;
};

export function ReportsPage({ client, money, tab, onTab, closeouts, expenses, payouts }: Props) {
  return <>
    <header><div><div className="eyebrow">STORE LEDGER</div><h1>Reports</h1>
      <p>Profit, shipping and fees, expenses, payouts, and period closeouts.</p></div></header>
    <div className="inventory-tabs report-tabs">
      <button type="button" className={tab === 'profit' ? 'active' : ''} onClick={() => onTab('profit')}>Profit</button>
      <button type="button" className={tab === 'shipping' ? 'active' : ''} onClick={() => onTab('shipping')}>Shipping &amp; fees</button>
      <button type="button" className={tab === 'expenses' ? 'active' : ''} onClick={() => onTab('expenses')}>Expenses</button>
      <button type="button" className={tab === 'payouts' ? 'active' : ''} onClick={() => onTab('payouts')}>Payouts</button>
    </div>
    {tab === 'profit' && <>
      <ChannelReportPage client={client} money={money} embedded />
      {closeouts}
    </>}
    {tab === 'shipping' && <>
      <ChannelReportPage client={client} money={money} embedded mode="fees" />
      <TaxReportPage client={client} money={money} embedded />
    </>}
    {tab === 'expenses' && expenses}
    {tab === 'payouts' && payouts}
  </>;
}
