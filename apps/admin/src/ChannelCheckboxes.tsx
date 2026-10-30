import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The only listing switches: eBay / Amazon / TikTok Shop. Depop stays manual. Admin only (enforced in the DB). */
export type ChannelId = 'ebay' | 'amazon' | 'tiktok';
export const LISTING_CHANNELS: [ChannelId, string][] = [['ebay', 'eBay'], ['amazon', 'Amazon'], ['tiktok', 'TikTok Shop']];

type ChannelState = {
  selected: boolean;
  live: boolean;
  never_reason: string | null;
  blocked_reason?: string | null;
  queue: { action: string; status: string; issue: string | null; last_error: string | null } | null;
};

function niceError(message: string) {
  if (message.includes('channel_upc_required')) return 'Add a valid UPC before selecting Amazon or TikTok Shop.';
  if (message.startsWith('channel_never_list')) return `Never listed there: ${message.split(':').slice(1).join(':').trim()}`;
  if (message.includes('portal_access_denied')) return 'Only admins can change channels.';
  return message;
}

/** Receive: pick channels before the unit exists; applied with applyChannelSelections after saving. */
export function ChannelPicker({ value, onChange, disabled = false, compact = false, upc = '' }: {
  value: ChannelId[]; onChange: (next: ChannelId[]) => void; disabled?: boolean; compact?: boolean; upc?: string;
}) {
  const hasUpc = validChannelUpc(upc);
  useEffect(() => {
    if (!hasUpc && value.some(id => id !== 'ebay')) onChange(value.filter(id => id === 'ebay'));
  }, [hasUpc, value, onChange]);
  return (
    <fieldset className={compact ? 'channel-picker channel-picker-compact' : 'channel-picker unit-edit-wide'} disabled={disabled}>
      {!compact && <legend>List on</legend>}
      {LISTING_CHANNELS.map(([id, label]) => (
        <label key={id} className="mboard-inline">
          <input
            type="checkbox"
            checked={value.includes(id)}
            disabled={id !== 'ebay' && !hasUpc}
            onChange={e => onChange(e.target.checked ? [...value.filter(c => c !== id), id] : value.filter(c => c !== id))}
          />
          {label}{id !== 'ebay' && !hasUpc && <small> · UPC required</small>}
        </label>
      ))}
    </fieldset>
  );
}

export async function applyChannelSelections(client: SupabaseClient, skus: string[], channels: ChannelId[]) {
  const warnings: string[] = [];
  for (const sku of skus) {
    for (const channel of channels) {
      const { error } = await client.rpc('portal_set_unit_channel_selection', { p_sku: sku, p_channel: channel, p_selected: true });
      if (error) warnings.push(`SKU ${sku} ${channel}: ${niceError(error.message)}`);
    }
  }
  return warnings;
}

/** Item edit: live checkboxes. Renders nothing for anyone the database refuses (clerks). */
export function ChannelCheckboxes({ client, sku, appMode = false }: { client: SupabaseClient; sku: string; appMode?: boolean }) {
  const [state, setState] = useState<Record<ChannelId, ChannelState> | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState<ChannelId | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_unit_channel_selections', { p_sku: sku });
    if (e) { setDenied(true); return; }
    setState(data as Record<ChannelId, ChannelState>);
  }, [client, sku]);

  useEffect(() => { void load(); }, [load]);

  if (denied || !state) return null;

  async function toggle(channel: ChannelId, on: boolean) {
    setBusy(channel);
    setError('');
    const { error: e } = await client.rpc('portal_set_unit_channel_selection', { p_sku: sku, p_channel: channel, p_selected: on });
    if (e) setError(niceError(e.message));
    await load();
    setBusy(null);
  }

  return (
    <fieldset className={`channel-picker unit-edit-wide${appMode ? ' app-channel-picker' : ''}`}>
      <legend>List on</legend>
      {LISTING_CHANNELS.map(([id, label]) => {
        const c = state[id];
        const status = c.never_reason || c.blocked_reason ? c.never_reason || c.blocked_reason
          : c.queue?.status === 'failed' ? `Listing issue: ${String(c.queue.issue || '').startsWith('Needs fix:') ? c.queue.issue : c.queue.last_error || c.queue.issue || 'failed'}`
          : c.queue ? `${c.queue.action === 'end' ? 'Ending' : 'Queued to list'}${c.queue.issue ? ` · ${c.queue.issue}` : ''}`
          : c.live ? 'Live' : '';
        return (
          <label key={id} className="mboard-inline" title={c.never_reason || c.blocked_reason || undefined}>
            <input
              type="checkbox"
              checked={c.selected}
              disabled={busy !== null || (!c.selected && Boolean(c.never_reason || c.blocked_reason))}
              onChange={e => void toggle(id, e.target.checked)}
            />
            {label}{status && <small> · {status}</small>}
          </label>
        );
      })}
      {error && <p className="error">{error}</p>}
    </fieldset>
  );
}

function validChannelUpc(raw: string) {
  const value = raw.trim();
  if (!/^(?:\d{8}|\d{12,14})$/.test(value) || /^0+$/.test(value)) return false;
  return [...value].reverse().reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1), 0) % 10 === 0;
}

type Issue = {
  id: number; sku: string; title: string | null; channel: ChannelId; action: string; status: string;
  attempts: number; issue: string | null; last_error: string | null; retryable: boolean; updated_at: string;
};

/** Admin "Listing issues": failed or blocked queue jobs with the reason. */
export function ListingIssuesPanel({ client }: { client: SupabaseClient }) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await client.rpc('portal_listing_issues', { p_limit: 200 });
    setIssues(error ? null : (data as Issue[]));
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  if (!issues?.length) return null;
  return (
    <section className="panel listing-issues">
      <h2>Listing issues ({issues.length})</h2>
      <table>
        <thead><tr><th>SKU</th><th>Item</th><th>Channel</th><th>Action</th><th>Reason</th><th /></tr></thead>
        <tbody>
          {issues.map(i => (
            <tr key={i.id}>
              <td>{i.sku}</td>
              <td>{i.title}</td>
              <td>{LISTING_CHANNELS.find(([id]) => id === i.channel)?.[1] ?? i.channel}</td>
              <td>{i.action}{i.attempts ? ` · ${i.attempts} tries` : ''}</td>
              <td>{String(i.issue || '').startsWith('Needs fix:') ? i.issue : i.last_error || i.issue}</td>
              <td><button type="button" className="secondary" onClick={async () => {
                await client.rpc('portal_retry_listing_issue', { p_id: i.id }); await load();
              }}>Retry now</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
