import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReactNode } from 'react';
import { EligibilityPage } from './EligibilityPage';
import { OnlineSellingPage } from './OnlineSellingPage';
import { LedgerSettingsPanel } from './LedgerSettingsPanel';
import { VendooExportPanel } from './VendooExportPanel';
type Props = {
  client: SupabaseClient;
  accessToken: string;
  stamp: (s: string) => string;
  money: (n: number) => string;
  busy: boolean;
  run: (f: () => Promise<void>) => Promise<void>;
  onLedgerChanged: () => Promise<void>;
  ruleEditor: ReactNode;
  onlinePayoutSettings: ReactNode;
};

export function SettingsPage({
  client, accessToken, stamp, money, busy, run, onLedgerChanged, ruleEditor, onlinePayoutSettings,
}: Props) {
  return <>
    <header><div><div className="eyebrow">CONFIGURATION</div><h1>Settings</h1>
      <p>Payout rules, ledger defaults, marketplace eligibility, and exports.</p></div></header>
    <section className="panel"><h2>Employee cuts (in-store sales)</h2>{ruleEditor}</section>
    {onlinePayoutSettings}
    <LedgerSettingsPanel client={client} money={money} busy={busy} run={run} onChanged={onLedgerChanged} />
    <EligibilityPage client={client} stamp={stamp} embedded />
    <OnlineSellingPage client={client} accessToken={accessToken} stamp={stamp} embedded />
    <VendooExportPanel client={client} />
  </>;
}
