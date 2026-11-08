import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from '../floorApi';
import './dropship.css';

type Desk = {
  enabled: boolean;
  paused: boolean;
  pause_reason: string | null;
  settings: Record<string, unknown>;
  ebay_channel_on: boolean;
  website_channel_on: boolean;
  daily_publish_cap: number;
  manual_place_remaining: number;
  last_supplier_order_at: string | null;
  suppliers: Array<{
    supplier: string;
    status: string;
    has_api_key: boolean;
    points_remaining: number | null;
    balance_cents: number | null;
    last_error: string | null;
  }>;
  catalog: { total: number; us: number; runs: Array<Record<string, unknown>> };
  picks: { pending: number; approved: number; listed: number };
  orders: { open: number };
  health: { late_pct?: number; tracking_pct?: number; defect_pct?: number } | null;
};

type Props = {
  client: SupabaseClient;
  session: Session;
  money: (n: number) => string;
  onBack?: () => void;
  backLabel?: string;
  embed?: 'app' | 'desktop';
};

type Section =
  | 'status'
  | 'suppliers'
  | 'catalog'
  | 'rules'
  | 'picks'
  | 'orders'
  | 'health'
  | 'settings'
  | null;

export function DropshipPage({ session, money, onBack, backLabel = 'Other', embed = 'app' }: Props) {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<Section>('status');
  const [picks, setPicks] = useState<Array<Record<string, unknown>>>([]);
  const [orders, setOrders] = useState<Array<Record<string, unknown>>>([]);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ebayLimit, setEbayLimit] = useState<number | null>(null);

  const call = useCallback(
    async (action: string, body: Record<string, unknown> = {}) => {
      const res = await fetch(floorFunctionUrl('dropship-admin'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action, ...body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || json.message || `http_${res.status}`);
      return json;
    },
    [session.access_token],
  );

  const refresh = useCallback(async () => {
    try {
      setError('');
      const d = (await call('desk')) as Desk;
      setDesk(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [call]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (open !== 'picks') return;
    void call('list_picks', { status: 'pending' })
      .then((r) => setPicks(r.picks || []))
      .catch((err) => setError(err.message));
  }, [open, call]);

  useEffect(() => {
    if (open !== 'orders' && open !== 'health') return;
    void call('list_orders')
      .then((r) => setOrders(r.orders || []))
      .catch((err) => setError(err.message));
    if (open === 'health') {
      void call('health')
        .then((r) => {
          setEbayLimit(r.ebay?.listingLimitRemaining ?? null);
          void refresh();
        })
        .catch(() => undefined);
    }
  }, [open, call, refresh]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  }

  const statusRight = !desk
    ? '…'
    : !desk.enabled
      ? 'OFF'
      : desk.paused
        ? 'Paused'
        : 'ON';

  const cj = desk?.suppliers?.find((s) => s.supplier === 'cj');
  const eprolo = desk?.suppliers?.find((s) => s.supplier === 'eprolo');
  const settings = (desk?.settings || {}) as Record<string, any>;
  const verified = settings.cj_blind_shipping_verified === true;

  return (
    <div className={`dropship-page ${embed === 'app' ? 'dropship-app' : 'dropship-desktop'}`}>
      {onBack ? (
        <div className="app-nav">
          <button type="button" onClick={onBack}>‹ {backLabel}</button>
          <div className="app-nav-title">Dropship</div>
          <button type="button" style={{ visibility: 'hidden' }}>·</button>
        </div>
      ) : (
        <header className="dropship-head">
          <h1>Dropship</h1>
        </header>
      )}

      <p className="dropship-status-line">
        Dropship is <b>{desk?.enabled ? (desk.paused ? 'PAUSED' : 'ON') : 'OFF'}</b>
        {!verified ? ' · eBay publish locked (packing slip unverified)' : ''}
      </p>

      {error ? <p className="dropship-error">{error}</p> : null}
      {busy ? <p className="dropship-muted">Working: {busy}…</p> : null}

      <div className="dropship-accord">
        <AccRow
          name="Status"
          right={statusRight}
          open={open === 'status'}
          onToggle={() => setOpen(open === 'status' ? null : 'status')}
          sub={desk?.pause_reason || (desk?.enabled ? 'Master switch' : 'Ships OFF by default')}
          danger={Boolean(desk?.paused || desk?.pause_reason)}
        >
          <div className="dropship-actions">
            <button
              type="button"
              className="dropship-btn"
              disabled={!!busy}
              onClick={() => run('toggle', () => call('set_enabled', { enabled: !desk?.enabled }).then(() => undefined))}
            >
              {desk?.enabled ? 'Turn OFF' : 'Turn ON'}
            </button>
            {desk?.enabled ? (
              <button
                type="button"
                className="dropship-btn outline"
                disabled={!!busy}
                onClick={() =>
                  run('pause', () =>
                    call('set_paused', { paused: !desk.paused, reason: desk.paused ? null : 'manual' }).then(() => undefined),
                  )
                }
              >
                {desk.paused ? 'Resume' : 'Pause'}
              </button>
            ) : null}
          </div>
          <p className="dropship-muted">
            Manual place remaining: {desk?.manual_place_remaining ?? '—'} · Daily publish cap: {desk?.daily_publish_cap ?? 5}
          </p>
        </AccRow>

        <AccRow
          name="Suppliers"
          right={cj?.status === 'connected' ? 'CJ ok' : cj?.status || '—'}
          open={open === 'suppliers'}
          onToggle={() => setOpen(open === 'suppliers' ? null : 'suppliers')}
          sub={
            cj?.points_remaining != null
              ? `CJ points left ${cj.points_remaining}`
              : eprolo?.status === 'waiting_docs'
                ? 'EPROLO waiting for API docs'
                : 'Enter keys here — never Netlify env'
          }
        >
          <SupplierBlock
            name="CJ Dropshipping"
            status={cj?.status || 'disconnected'}
            detail={
              [
                cj?.has_api_key ? 'Key saved' : 'No key',
                cj?.points_remaining != null ? `${cj.points_remaining} pts` : null,
                cj?.balance_cents != null ? money(cj.balance_cents) : null,
                cj?.last_error,
              ]
                .filter(Boolean)
                .join(' · ')
            }
          >
            <label className="dropship-label">
              API key
              <input
                className="dropship-input"
                type="password"
                autoComplete="off"
                placeholder={cj?.has_api_key ? '•••• saved — paste to replace' : 'Paste CJ API key'}
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
              />
            </label>
            <div className="dropship-actions">
              <button
                type="button"
                className="dropship-btn"
                disabled={!!busy || !apiKeyDraft.trim()}
                onClick={() =>
                  run('save key', async () => {
                    await call('save_api_key', { supplier: 'cj', api_key: apiKeyDraft.trim() });
                    setApiKeyDraft('');
                  })
                }
              >
                Save key
              </button>
              <button
                type="button"
                className="dropship-btn outline"
                disabled={!!busy || !cj?.has_api_key}
                onClick={() => run('test CJ', () => call('test_connection', { supplier: 'cj' }).then(() => undefined))}
              >
                Test connection
              </button>
            </div>
            <p className="dropship-muted">
              How Paul enters keys: More → Other → Dropship → Suppliers → paste the CJ API key → Save key.
              It is encrypted with CONNECTIONS_KEY into Supabase (`dropship_supplier_credentials`). The full key is never shown again.
            </p>
          </SupplierBlock>

          <SupplierBlock name="EPROLO" status="waiting for API docs" detail="Stub adapter — fails closed until docs arrive" />
          <SupplierBlock name="Doba" status="disabled / unused" detail="Kept for reference; not called" />
          <SupplierBlock name="Printify" status="waiting for setup" detail="Likely next for branded merch" />
        </AccRow>

        <AccRow
          name="Catalog"
          right={desk ? String(desk.catalog?.us ?? 0) : '—'}
          open={open === 'catalog'}
          onToggle={() => setOpen(open === 'catalog' ? null : 'catalog')}
          sub={desk ? `${desk.catalog?.total ?? 0} imported · US filter on` : 'US warehouse import'}
        >
          <p className="dropship-muted">
            Import runs in GitHub Actions (resumable chunks) plus a manual chunk from this screen. Points are throttled; we never burn the whole day.
          </p>
          {(desk?.catalog?.runs || []).slice(0, 1).map((r) => (
            <p key={String(r.id)} className="dropship-muted">
              Last run: {String(r.status)} · page {String(r.cursor_page)} · imported {String(r.imported_count)} · points {String(r.points_spent)}
              {r.last_error ? ` · ${String(r.last_error)}` : ''}
            </p>
          ))}
          <div className="dropship-actions">
            <button
              type="button"
              className="dropship-btn"
              disabled={!!busy || !desk?.enabled}
              onClick={() => run('import', () => call('import_chunk', { maxPages: 5 }).then(() => undefined))}
            >
              Import chunk
            </button>
            <button
              type="button"
              className="dropship-btn outline"
              disabled={!!busy}
              onClick={() => run('pause import', () => call('pause_import', {}).then(() => undefined))}
            >
              Pause import
            </button>
          </div>
        </AccRow>

        <AccRow
          name="Rules"
          right="Hunter"
          open={open === 'rules'}
          onToggle={() => setOpen(open === 'rules' ? null : 'rules')}
          sub="Editable defaults — landed ≤38%, min $15, $5 + 40% margin"
        >
          <RuleGrid settings={settings} />
          <div className="dropship-actions">
            <button
              type="button"
              className="dropship-btn outline"
              disabled={!!busy}
              onClick={() =>
                run('save rules', () =>
                  call('save_settings', {
                    settings: {
                      ...settings,
                      // keep as-is; edits happen via inputs below in a follow-up — expose key toggles:
                    },
                  }).then(() => undefined),
                )
              }
            >
              Save rules
            </button>
          </div>
          <FeeTable
            fees={settings.channel_fees || {}}
            onChange={(channel_fees) => {
              void run('fees', () => call('save_settings', { settings: { ...settings, channel_fees } }).then(() => undefined));
            }}
          />
          <label className="dropship-check">
            <input
              type="checkbox"
              checked={verified}
              onChange={(e) =>
                void run('blind ship flag', () =>
                  call('save_settings', {
                    settings: { ...settings, cj_blind_shipping_verified: e.target.checked },
                  }).then(() => undefined),
                )
              }
            />
            I confirm CJ packing slips show Open Box Industries (blind shipping verified)
          </label>
        </AccRow>

        <AccRow
          name="Picks"
          right={desk ? String(desk.picks?.pending ?? 0) : '—'}
          open={open === 'picks'}
          onToggle={() => setOpen(open === 'picks' ? null : 'picks')}
          sub={desk ? `${desk.picks?.approved ?? 0} approved · ${desk.picks?.listed ?? 0} live` : 'Ranked list'}
        >
          <div className="dropship-actions">
            <button
              type="button"
              className="dropship-btn"
              disabled={!!busy || !desk?.enabled}
              onClick={() => run('hunter', () => call('run_hunter', {}).then(() => undefined))}
            >
              Run hunter
            </button>
          </div>
          <div className="dropship-list">
            {picks.map((p) => (
              <div key={String(p.id)} className="dropship-list-row">
                <div>
                  <div className="dropship-list-title">{String((p.catalog as any)?.title || 'Pick')}</div>
                  <div className="dropship-muted">
                    {String(p.channel)} · ask {money(Number(p.suggested_price_cents) || 0)} · profit {money(Number(p.profit_cents) || 0)} ·{(Number(p.margin_bps) / 100).toFixed(0)}%
                  </div>
                  <div className="dropship-muted">{String(p.reason || '')}</div>
                </div>
                <div className="dropship-actions col">
                  <button type="button" className="dropship-btn" disabled={!!busy} onClick={() => run('approve', () => call('decide_pick', { pick_id: p.id, decision: 'approved' }).then(() => undefined))}>
                    Approve
                  </button>
                  <button type="button" className="dropship-btn outline" disabled={!!busy} onClick={() => run('reject', () => call('decide_pick', { pick_id: p.id, decision: 'rejected' }).then(() => undefined))}>
                    Reject
                  </button>
                </div>
              </div>
            ))}
            {!picks.length ? <p className="dropship-muted">No pending picks.</p> : null}
          </div>
        </AccRow>

        <AccRow
          name="Orders"
          right={desk ? String(desk.orders?.open ?? 0) : '—'}
          open={open === 'orders'}
          onToggle={() => setOpen(open === 'orders' ? null : 'orders')}
          sub="First 10 need Place order · never auto cancel/refund"
        >
          <div className="dropship-list">
            {orders.map((o) => (
              <div key={String(o.id)} className="dropship-list-row">
                <div>
                  <div className="dropship-list-title">{String(o.sku)} · {String(o.status)}</div>
                  <div className="dropship-muted">
                    {o.supplier_order_id ? `Supplier ${String(o.supplier_order_id)}` : 'No supplier order'}
                    {o.tracking_number ? ` · ${String(o.tracking_number)}` : ''}
                    {o.pause_reason ? ` · ${String(o.pause_reason)}` : ''}
                  </div>
                </div>
                {o.status === 'awaiting_place' || o.status === 'paused' ? (
                  <button
                    type="button"
                    className="dropship-btn"
                    disabled={!!busy}
                    onClick={() => run('place', () => call('place_order', { order_id: o.id }).then(() => undefined))}
                  >
                    Place order
                  </button>
                ) : null}
              </div>
            ))}
            {!orders.length ? <p className="dropship-muted">No dropship orders.</p> : null}
          </div>
        </AccRow>

        <AccRow
          name="Health"
          right={desk?.health ? `${Number(desk.health.late_pct || 0).toFixed(1)}% late` : '—'}
          open={open === 'health'}
          onToggle={() => setOpen(open === 'health' ? null : 'health')}
          sub="Auto-pause at 3% late / &lt;96% tracking / 0.8% defects"
          danger={Boolean(desk?.paused)}
        >
          <div className="dropship-stats">
            <div><span>Late</span><b>{desk?.health ? `${Number(desk.health.late_pct).toFixed(2)}%` : '—'}</b></div>
            <div><span>Tracking</span><b>{desk?.health ? `${Number(desk.health.tracking_pct).toFixed(2)}%` : '—'}</b></div>
            <div><span>Defects</span><b>{desk?.health ? `${Number(desk.health.defect_pct).toFixed(2)}%` : '—'}</b></div>
          </div>
          <p className="dropship-muted">
            CJ balance: {cj?.balance_cents != null ? money(cj.balance_cents) : '—'} · Points: {cj?.points_remaining ?? '—'}
          </p>
          <p className="dropship-muted">
            Last supplier order: {desk?.last_supplier_order_at || 'never'} · Keep-alive: alert ~7 days before 30-day idle suspension (bot never auto-spends)
          </p>
          <p className="dropship-muted">eBay listing limit remaining: {ebayLimit ?? '—'}</p>
        </AccRow>

        <AccRow
          name="Settings"
          right={`Cap ${desk?.daily_publish_cap ?? 5}`}
          open={open === 'settings'}
          onToggle={() => setOpen(open === 'settings' ? null : 'settings')}
          sub="Channels · end all eBay dropship listings"
        >
          <label className="dropship-check">
            <input
              type="checkbox"
              checked={Boolean(desk?.ebay_channel_on)}
              onChange={(e) =>
                void run('ebay ch', () => call('save_settings', { ebay_channel_on: e.target.checked }).then(() => undefined))
              }
            />
            eBay channel (US warehouse only)
          </label>
          <label className="dropship-check">
            <input
              type="checkbox"
              checked={Boolean(desk?.website_channel_on)}
              onChange={(e) =>
                void run('web ch', () => call('save_settings', { website_channel_on: e.target.checked }).then(() => undefined))
              }
            />
            Website · Everyday deals
          </label>
          <p className="dropship-muted">TikTok Shop and Amazon: OFF (settings only). Depop and Mercari: hard-blocked in code.</p>
          <label className="dropship-label">
            Daily publish cap
            <input
              className="dropship-input"
              type="number"
              min={0}
              max={100}
              defaultValue={desk?.daily_publish_cap ?? 5}
              onBlur={(e) =>
                void run('cap', () =>
                  call('save_settings', { daily_publish_cap: Number(e.target.value) || 5 }).then(() => undefined),
                )
              }
            />
          </label>
          {!confirmEnd ? (
            <button type="button" className="dropship-btn outline danger" onClick={() => setConfirmEnd(true)}>
              End all dropship listings on eBay
            </button>
          ) : (
            <div className="dropship-actions">
              <button
                type="button"
                className="dropship-btn danger"
                disabled={!!busy}
                onClick={() =>
                  run('end all', async () => {
                    await call('end_all_ebay', { confirm: 'END_ALL_DROPSHIP' });
                    setConfirmEnd(false);
                  })
                }
              >
                Confirm end all
              </button>
              <button type="button" className="dropship-btn outline" onClick={() => setConfirmEnd(false)}>
                Cancel
              </button>
            </div>
          )}
        </AccRow>
      </div>
    </div>
  );
}

function AccRow({
  name, right, sub, open, onToggle, children, danger,
}: {
  name: string; right: string; sub?: string; open: boolean; onToggle: () => void; children: ReactNode; danger?: boolean;
}) {
  return (
    <div>
      <button type="button" className="dropship-acc-row" onClick={onToggle}>
        <span className="dropship-acc-name">{name}</span>
        <span className={`dropship-acc-right ${danger ? 'danger' : ''}`}>{right}</span>
        <span className="dropship-acc-chev">{open ? '▾' : '›'}</span>
        {sub ? <span className={`dropship-acc-sub ${danger ? 'danger' : ''}`}>{sub}</span> : null}
      </button>
      {open ? <div className="dropship-acc-body">{children}</div> : null}
    </div>
  );
}

function SupplierBlock({ name, status, detail, children }: { name: string; status: string; detail: string; children?: ReactNode }) {
  return (
    <div className="dropship-supplier">
      <div className="dropship-list-title">{name}</div>
      <div className="dropship-muted">{status} · {detail}</div>
      {children}
    </div>
  );
}

function RuleGrid({ settings }: { settings: Record<string, any> }) {
  return (
    <div className="dropship-stats">
      <div><span>Max landed %</span><b>{settings.max_landed_pct_of_price ?? 38}%</b></div>
      <div><span>Min retail</span><b>${((settings.min_retail_cents ?? 1500) / 100).toFixed(0)}</b></div>
      <div><span>Min profit</span><b>${((settings.min_profit_cents ?? 500) / 100).toFixed(0)}</b></div>
      <div><span>Min margin</span><b>{((settings.min_margin_bps ?? 4000) / 100).toFixed(0)}%</b></div>
      <div><span>Reserve</span><b>{((settings.return_reserve_bps ?? 500) / 100).toFixed(0)}%</b></div>
      <div><span>Max ships-in</span><b>{settings.max_ships_in_days ?? 5}d</b></div>
    </div>
  );
}

function FeeTable({ fees, onChange }: { fees: Record<string, any>; onChange: (f: Record<string, any>) => void }) {
  const rows = ['ebay', 'website', 'tiktok', 'amazon'];
  return (
    <div className="dropship-fees">
      {rows.map((ch) => {
        const f = fees[ch] || {};
        return (
          <label key={ch} className="dropship-label">
            {ch} fees {f.verify ? '(verify)' : ''}
            <span className="dropship-fee-row">
              <input
                className="dropship-input"
                type="number"
                step="0.01"
                defaultValue={f.pct ?? 0}
                onBlur={(e) => onChange({ ...fees, [ch]: { ...f, pct: Number(e.target.value), verify: true } })}
              />
              % +
              <input
                className="dropship-input"
                type="number"
                defaultValue={f.flat_cents ?? 0}
                onBlur={(e) => onChange({ ...fees, [ch]: { ...f, flat_cents: Number(e.target.value), verify: true } })}
              />
              ¢
            </span>
          </label>
        );
      })}
    </div>
  );
}
