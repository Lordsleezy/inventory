import { useCallback, useEffect, useState } from 'react';
import { floorFunctionUrl } from './floorApi';
import { errText } from './errText';
import './connections.css';

type Provider = 'ebay' | 'amazon' | 'tiktok';
type EbayAccount = { id: string; username: string; role: string; status: string };
type Connection = {
  connected: boolean;
  accounts?: EbayAccount[];
  username?: string | null;
  ordersOnly?: boolean;
  requiredUsername?: string;
};
type CardState = { connection?: Connection; error?: string; loading: boolean };
const providers: { key: Provider; label: string; endpoint: string }[] = [
  { key: 'ebay', label: 'eBay', endpoint: 'ebay-connection' },
  { key: 'amazon', label: 'Amazon', endpoint: 'amazon-list' },
  { key: 'tiktok', label: 'TikTok', endpoint: 'tiktok-list' },
];

async function request(token: string, endpoint: string, action?: string) {
  const response = await fetch(floorFunctionUrl(endpoint), {
    headers: { Authorization: `Bearer ${token}`, ...(action ? { 'content-type': 'application/json' } : {}) },
    ...(action ? { method: 'POST', body: JSON.stringify({ action }) } : {}),
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) throw new Error(body.message || body.error || `Request failed (${response.status})`);
  return body;
}

export function ConnectionsPage({ accessToken, standalone = false }: { accessToken: string; standalone?: boolean }) {
  const [cards, setCards] = useState<Partial<Record<Provider, CardState>>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const load = useCallback(async (key: Provider) => {
    const provider = providers.find(p => p.key === key)!;
    setCards(old => ({ ...old, [key]: { loading: true } }));
    try {
      const connection: Connection = await request(accessToken, provider.endpoint, 'status');
      setCards(old => ({ ...old, [key]: { connection, loading: false } }));
    } catch (error) {
      setCards(old => ({ ...old, [key]: { error: errText(error), loading: false } }));
    }
  }, [accessToken]);

  useEffect(() => {
    const refresh = () => { for (const { key } of providers) void load(key); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [load]);

  async function connect(key: Provider, role = 'selling') {
    setConnecting(`${key}:${role}`);
    setCards(old => ({ ...old, [key]: { ...old[key]!, error: undefined } }));
    try {
      const body = key === 'ebay'
        ? await request(accessToken, 'ebay-connection', role === 'orders_only' ? 'connect_orders_only' : 'connect_selling')
        : await request(accessToken, `oauth-start?provider=${key}`);
      if (!body.url) throw new Error('No login URL returned. Please try again.');
      window.location.assign(body.url);
    } catch (error) {
      setCards(old => ({ ...old, [key]: { ...old[key]!, error: errText(error) } }));
    } finally {
      setConnecting(null);
    }
  }

  function login(key: Provider, role = 'selling', label = 'Log in to connect') {
    return <button type="button" className="connection-login" disabled={connecting !== null} onClick={() => void connect(key, role)}>
      {connecting === `${key}:${role}` ? 'Opening login…' : label}
    </button>;
  }

  return <div className="connections-page">
    {!standalone && <header><h1>Connections & sync</h1></header>}
    <div className="connection-cards">
      {providers.map(({ key, label }) => {
        const state = cards[key];
        const connection = state?.connection;
        const accounts = connection?.accounts || [];
        // Keep the legacy account visible until the backend has backfilled ebay_accounts.
        const ebayAccounts = accounts.length ? accounts : connection?.connected && connection.username
          ? [{ id: 'legacy', username: connection.username, role: connection.ordersOnly ? 'orders_only' : 'selling', status: 'connected' }]
          : [];
        const hasRole = (role: string) => ebayAccounts.some(a => a.role === role);
        return <section className={`connection-card connection-${key}`} key={key} aria-labelledby={`connection-${key}`}>
          <div className="connection-heading">
            <span className="connection-icon" aria-hidden="true">{key === 'ebay' ? 'e' : key === 'amazon' ? 'a' : '♪'}</span>
            <h2 id={`connection-${key}`}>{label}</h2>
            <span className={`connection-status${connection?.connected ? ' is-connected' : ''}`} role="status">
              {!state || state.loading ? 'Checking…' : connection ? connection.connected ? 'Connected' : 'Disconnected' : 'Status unavailable'}
            </span>
          </div>
          {state?.error && <div className="connection-error" role="alert">{state.error} <button type="button" onClick={() => void load(key)}>Retry</button></div>}
          {connection && !state?.loading && (key === 'ebay' ? <div className="connection-accounts">
            {ebayAccounts.map(account => <div className="connection-account" key={account.id}>
              <div><strong>{account.username}</strong><small>{account.role === 'selling' ? 'Store account' : 'Orders only'}</small></div>
              <span className={`connection-status${account.status === 'connected' ? ' is-connected' : ''}`}>{account.status === 'connected' ? 'Connected' : 'Disconnected'}</span>
              {account.status !== 'connected' && login(key, account.role)}
            </div>)}
            {!hasRole('selling') && <div className="connection-account"><div><strong>ikonikdeals2026</strong><small>Store account · Disconnected</small></div>{login(key)}</div>}
            {!hasRole('orders_only') && <div className="connection-account"><div><strong>{connection.requiredUsername || 'pgg124-5'}</strong><small>Orders only · Disconnected</small></div>{login(key, 'orders_only')}</div>}
          </div> : !connection.connected && login(key))}
        </section>;
      })}
    </div>
  </div>;
}
