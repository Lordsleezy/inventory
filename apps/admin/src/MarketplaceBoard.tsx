import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { floorFunctionUrl } from './floorApi';
import { errText } from './errText';
import { shortError } from './appMode/shortError';

export type BoardChannel = 'ebay' | 'amazon' | 'tiktok';
type Tab = 'listed' | 'not_listed' | 'sold';

type CatalogRow = {
  key: string;
  sku: string | null;
  title: string;
  price_cents: number | null;
  qty: number | null;
  asin: string | null;
  upc: string | null;
  condition: string | null;
  listed_at: string | null;
  shipping: 'free' | 'buyer' | 'unknown' | string;
  floor_ask_cents?: number | null;
  fix_section?: string | null;
  photo_url: string | null;
  offer_id: string | null;
  offer_sku: string | null;
  account_id: string | null;
  account: string | null;
  product_id: string | null;
  item_id: string | null;
  url: string | null;
  live: boolean;
  blocked: boolean;
  blocked_reason: string | null;
};

type SoldRow = {
  key: string;
  sale_id: number;
  sku: string | null;
  title: string;
  condition: string | null;
  upc: string | null;
  qty: number;
  sold_at: string;
  price_cents: number;
  shipping_cents: number;
  fee_cents: number;
  label_cents: number;
  cost_cents: number;
  processing_fee_cents: number;
  profit_cents: number | null;
  net_cents: number | null;
  receipt_no: string;
  order_no: string;
  buyer_name: string | null;
  buyer_email: string | null;
  photo_url: string | null;
};

type Stats = {
  orders: number;
  gross_cents: number;
  fee_cents: number;
  fee_pct: number;
  ship_cents: number;
  profit_cents: number;
  voided_count: number;
  insertion_cents: number;
};

type Quarter = { id: string; label: string };
type Job = {
  status?: string;
  kind?: string;
  progress?: { current?: number; total?: number; message?: string; sku?: string };
  results?: { sku?: string; ok?: boolean; error?: string | null }[];
  summary?: { total: number; ok: number; failed: number };
};

type Props = {
  channel: BoardChannel;
  accessToken: string;
  money: (n: number) => string;
};

const PAGE = 40;
const ZONE = 'America/Los_Angeles';
const NAMES: Record<BoardChannel, { title: string; fee: string }> = {
  ebay: { title: 'eBay', fee: 'eBay fees' },
  amazon: { title: 'Amazon', fee: 'Amazon fees' },
  tiktok: { title: 'TikTok', fee: 'TikTok fees' },
};
const CONDITIONS = ['New (sealed)', 'Open box', 'Defective/non-sellable'];

function boardCacheKey(channel: BoardChannel) {
  return `floor_board_cache_${channel}`;
}

function readBoardCache(channel: BoardChannel): {
  listed?: CatalogRow[];
  not_listed?: CatalogRow[];
  connected?: boolean;
  connect_message?: string;
  warnings?: string[];
  accounts?: { username?: string; live_count?: number; error?: string | null }[];
  last_synced?: string | null;
} | null {
  try {
    const raw = sessionStorage.getItem(boardCacheKey(channel));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeBoardCache(channel: BoardChannel, pack: Record<string, unknown>) {
  try {
    sessionStorage.setItem(boardCacheKey(channel), JSON.stringify(pack));
  } catch {
    /* quota / private mode */
  }
}

function clientQuarter(now = new Date()): Quarter {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: 'numeric' }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const q = Math.floor((month - 1) / 3) + 1;
  const span = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'][q - 1];
  return { id: `${year}-Q${q}`, label: `Q${q} ${year} (${span})` };
}

function stamp(iso: string | null, withYear = false) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' as const } : {}),
  }).format(new Date(iso));
}

function escapeHtml(value: string) {
  return String(value || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
}

function matches(row: { sku?: string | null; title?: string | null; upc?: string | null; asin?: string | null; order_no?: string; receipt_no?: string; condition?: string | null }, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.sku, row.title, row.upc, row.asin, row.order_no, row.receipt_no, row.condition].filter(Boolean).join(' ').toLowerCase().includes(q);
}

function parseAspects(text: string): Record<string, string[]> | null {
  const out: Record<string, string[]> = {};
  for (const line of text.split(/\n+/)) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) out[key] = [value];
  }
  return Object.keys(out).length ? out : null;
}

function aspectsToText(aspects: unknown) {
  if (!aspects || typeof aspects !== 'object') return '';
  return Object.entries(aspects as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value ?? '')}`)
    .join('\n');
}

async function call(token: string, body: Record<string, unknown>) {
  const res = await fetch(floorFunctionUrl('listing-manager'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function unwrap(status: number, json: { ok?: boolean; error?: string; message?: string }) {
  if (status >= 400 || json.ok === false) throw new Error(json.error || json.message || `Request failed (${status})`);
  return json;
}

function printDocument(title: string, body: string) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('style', 'position:fixed;right:0;bottom:0;width:0;height:0;border:0');
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) return;
  doc.open();
  doc.write(`<!doctype html><html><head><title>${escapeHtml(title)}</title><style>
    body{font-family:Georgia,serif;color:#111;margin:24px} h1{font-size:22px;margin:0 0 4px}
    table{width:100%;border-collapse:collapse;margin:12px 0} td,th{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left;font-size:13px}
    td.num,th.num{text-align:right} .sheet{page-break-after:always} .sheet:last-child{page-break-after:auto}
    .meta{color:#444;font-size:13px} .legal{font-size:11px;color:#333;margin-top:16px}
    .totals div{display:flex;justify-content:space-between;padding:2px 0} .strong{font-weight:700;font-size:16px}
  </style></head><body>${body}</body></html>`);
  doc.close();
  const win = iframe.contentWindow;
  if (!win) return;
  win.focus();
  setTimeout(() => {
    win.print();
    setTimeout(() => iframe.remove(), 1500);
  }, 200);
}

function downloadCsv(name: string, rows: string[][]) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function MarketplaceBoard({ channel, accessToken, money }: Props) {
  const meta = NAMES[channel];
  const cached = useMemo(() => readBoardCache(channel), [channel]);
  const [tab, setTab] = useState<Tab>('listed');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [quarter, setQuarter] = useState(() => clientQuarter().id);
  const [quarters, setQuarters] = useState<Quarter[]>(() => [clientQuarter()]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [listed, setListed] = useState<CatalogRow[]>(() => cached?.listed || []);
  const [notListed, setNotListed] = useState<CatalogRow[]>(() => cached?.not_listed || []);
  const [sold, setSold] = useState<SoldRow[]>([]);
  const [connected, setConnected] = useState(() => cached?.connected ?? channel !== 'tiktok');
  const [connectMessage, setConnectMessage] = useState(() => cached?.connect_message || '');
  const [warnings, setWarnings] = useState<string[]>(() => cached?.warnings || []);
  const [accounts, setAccounts] = useState<{ username?: string; live_count?: number; error?: string | null }[]>(() => cached?.accounts || []);
  const [lastSynced, setLastSynced] = useState<string | null>(() => cached?.last_synced || null);
  const [catalogBusy, setCatalogBusy] = useState(() => !cached);
  const [quarterBusy, setQuarterBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<Job | null>(null);
  const [edit, setEdit] = useState<CatalogRow | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editQty, setEditQty] = useState('1');
  const [editCondition, setEditCondition] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editShip, setEditShip] = useState('');
  const [editShipBase, setEditShipBase] = useState('');
  const [editAspects, setEditAspects] = useState('');
  const [editImages, setEditImages] = useState('');
  const [editBase, setEditBase] = useState({ title: '', desc: '', qty: '1', note: '', aspects: '', images: '' });
  const [editThumbs, setEditThumbs] = useState<string[]>([]);
  const [editBusy, setEditBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [eligible, setEligible] = useState<{ sku: string; title: string | null; ask_cents: number | null }[]>([]);
  const [eligibleQuery, setEligibleQuery] = useState('');
  const [showMigrate, setShowMigrate] = useState(false);
  const [legacy, setLegacy] = useState<{ sku: string; listing_id: string; title: string }[]>([]);
  const [markSold, setMarkSold] = useState<CatalogRow[] | null>(null);
  const [soldPrice, setSoldPrice] = useState('');
  const [useListedPrice, setUseListedPrice] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<CatalogRow[] | null>(null);
  const headRef = useRef<HTMLInputElement>(null);
  const jobSeen = useRef<string>('');

  const loadCatalog = useCallback(async (opts?: { force?: boolean }) => {
    setCatalogBusy((prev) => prev || !(cached?.listed?.length || cached?.not_listed?.length));
    try {
      const { status, json } = await call(accessToken, {
        action: 'board_catalog',
        channel,
        ...(opts?.force ? { force: true } : {}),
      });
      const body = unwrap(status, json) as {
        listed?: CatalogRow[];
        not_listed?: CatalogRow[];
        connected?: boolean;
        connect_message?: string | null;
        warnings?: string[];
        message?: string | null;
        accounts?: { username?: string; live_count?: number; error?: string | null }[];
        last_synced?: { at?: string } | null;
      };
      const nextListed = body.listed || [];
      const nextNotListed = body.not_listed || [];
      const nextConnected = body.connected !== false;
      const nextMessage = body.connect_message || '';
      setListed(nextListed);
      setNotListed(nextNotListed);
      setConnected(nextConnected);
      setConnectMessage(nextMessage);
      const notes = body.connected === false ? [] : [...(body.warnings || [])];
      if (body.connected !== false && body.message && !notes.includes(body.message)) notes.push(body.message);
      for (const a of body.accounts || []) {
        if (a.error) notes.push(`${a.username || 'Account'}: ${shortError(a.error)}`);
      }
      const nextWarnings = [...new Set(notes.filter(Boolean).map((n) => shortError(n)))];
      const nextAccounts = body.accounts || [];
      const nextSynced = body.last_synced?.at || null;
      setWarnings(nextWarnings);
      setAccounts(nextAccounts);
      setLastSynced(nextSynced);
      writeBoardCache(channel, {
        listed: nextListed,
        not_listed: nextNotListed,
        connected: nextConnected,
        connect_message: nextMessage,
        warnings: nextWarnings,
        accounts: nextAccounts,
        last_synced: nextSynced,
      });
    } catch (e) {
      setError(shortError(errText(e)));
      // Keep any sessionStorage-painted or prior rows on refresh failure.
    } finally {
      setCatalogBusy(false);
    }
  }, [accessToken, channel, cached]);

  const loadQuarter = useCallback(async (id: string) => {
    setQuarterBusy(true);
    try {
      const { status, json } = await call(accessToken, { action: 'board_quarter', channel, quarter: id });
      const body = unwrap(status, json) as { stats?: Stats; sold?: SoldRow[]; quarters?: Quarter[]; quarter?: Quarter };
      setStats(body.stats || null);
      setSold(body.sold || []);
      const next = body.quarters?.length ? body.quarters : [clientQuarter()];
      setQuarters(next);
      if (body.quarter?.id && !next.some((q) => q.id === id)) setQuarter(body.quarter.id);
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setQuarterBusy(false);
    }
  }, [accessToken, channel]);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);
  useEffect(() => { void loadQuarter(quarter); }, [loadQuarter, quarter]);

  const pollJob = useCallback(async () => {
    const { status, json } = await call(accessToken, { action: 'board_job_status' });
    if (status >= 400 || json.ok === false) return;
    const next = (json.job || null) as Job | null;
    setJob(next);
    if (!next || (next.status !== 'running' && next.status !== 'queued')) {
      const stampKey = `${next?.status}:${next?.progress?.message || ''}:${next?.summary?.ok ?? ''}`;
      if (next?.status === 'completed' && jobSeen.current !== stampKey) {
        jobSeen.current = stampKey;
        const failed = (next.results || []).filter((row) => !row.ok);
        setNotice(next.progress?.message || 'Job finished');
        if (failed.length) setError(failed.map((row) => `${row.sku}: ${row.error || 'failed'}`).join(' · '));
        setSelected(new Set());
        void loadCatalog({ force: true });
        void loadQuarter(quarter);
      }
    }
  }, [accessToken, loadCatalog, loadQuarter, quarter]);

  useEffect(() => {
    void call(accessToken, { action: 'board_job_status' }).then(({ json }) => {
      const next = json.job as Job | null;
      if (next && (next.status === 'running' || next.status === 'queued')) setJob(next);
    }).catch(() => undefined);
  }, [accessToken]);

  useEffect(() => {
    if (!job || (job.status !== 'running' && job.status !== 'queued')) return;
    const timer = window.setInterval(() => { void pollJob(); }, 2000);
    return () => window.clearInterval(timer);
  }, [job, pollJob]);

  const source = tab === 'listed' ? listed : tab === 'not_listed' ? notListed : sold;
  const filtered = useMemo(() => source.filter((row) => matches(row, query)), [source, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const safePage = Math.min(page, pages - 1);
  const visible = filtered.slice(safePage * PAGE, safePage * PAGE + PAGE);
  const visibleKeys = visible.map((row) => row.key);
  const allVisible = visibleKeys.length > 0 && visibleKeys.every((key) => selected.has(key));
  const someVisible = visibleKeys.some((key) => selected.has(key));

  useEffect(() => {
    if (headRef.current) headRef.current.indeterminate = someVisible && !allVisible;
  }, [someVisible, allVisible]);
  useEffect(() => {
    if (page > pages - 1) setPage(Math.max(0, pages - 1));
  }, [page, pages]);

  function togglePage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisible) visibleKeys.forEach((key) => next.delete(key));
      else visibleKeys.forEach((key) => next.add(key));
      return next;
    });
  }
  function toggleKey(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function selectAllFiltered() {
    setSelected(new Set(filtered.map((row) => row.key)));
  }

  const pickedCatalog = filtered.filter((row): row is CatalogRow => selected.has(row.key) && 'live' in row) as CatalogRow[];
  const pickedSold = filtered.filter((row): row is SoldRow => selected.has(row.key) && 'sale_id' in row);

  async function startJob(kind: string, rows: CatalogRow[], priceFor?: (row: CatalogRow) => number | null) {
    const items = rows.filter((row) => row.sku).map((row) => ({
      sku: row.sku,
      offer_id: row.offer_id,
      offer_sku: row.offer_sku,
      account_id: row.account_id,
      product_id: row.product_id,
      item_id: row.item_id,
      price_cents: priceFor ? priceFor(row) : row.price_cents,
    }));
    if (!items.length) return;
    setError('');
    const { status, json } = await call(accessToken, { action: 'board_job', channel, kind, items });
    const body = unwrap(status, json) as { message?: string };
    setNotice(body.message || 'Job started');
    setJob({ status: 'queued', kind, progress: { current: 0, total: items.length, message: body.message || 'Queued' } });
    jobSeen.current = '';
  }

  async function openEdit(row: CatalogRow) {
    setEditBusy(true);
    setError('');
    setEdit(row);
    const askCents = row.floor_ask_cents ?? null;
    const ship = row.shipping === 'free' ? 'free' : row.shipping === 'buyer' ? 'calculated' : '';
    const opened = {
      title: row.title || '',
      desc: '',
      qty: row.qty != null ? String(row.qty) : '1',
      note: '',
      aspects: '',
      images: '',
    };
    setEditTitle(opened.title);
    setEditDesc(opened.desc);
    setEditPrice(askCents != null ? (askCents / 100).toFixed(2) : '');
    setEditQty(opened.qty);
    setEditCondition(row.condition || '');
    setEditNote(opened.note);
    setEditShip(ship);
    setEditShipBase(ship);
    setEditAspects(opened.aspects);
    setEditImages(opened.images);
    setEditBase(opened);
    setEditThumbs(row.photo_url ? [row.photo_url] : []);
    try {
      const { status, json } = await call(accessToken, {
        action: 'detail',
        channel,
        sku: row.sku,
        offer_id: row.offer_id,
        account_id: row.account_id,
        product_id: row.product_id,
      });
      if (status >= 400 || json.ok === false) {
        setError(json.error || json.message || `Could not open the listing (${status})`);
      } else {
        const detail = json as {
          title?: string; description?: string; price_cents?: number; qty?: number;
          condition_description?: string; condition_note?: string; aspects?: unknown;
          image_urls?: string[]; photos?: { url?: string }[]; unit?: { condition?: string };
        };
        const loaded = {
          title: detail.title || row.title || '',
          desc: detail.description || '',
          qty: detail.qty != null ? String(detail.qty) : (row.qty != null ? String(row.qty) : '1'),
          note: detail.condition_description || detail.condition_note || '',
          aspects: aspectsToText(detail.aspects),
          images: (detail.image_urls || []).filter(Boolean).join('\n'),
        };
        setEditTitle(loaded.title);
        setEditDesc(loaded.desc);
        setEditQty(loaded.qty);
        setEditCondition(detail.unit?.condition || row.condition || '');
        setEditNote(loaded.note);
        setEditAspects(loaded.aspects);
        setEditImages(loaded.images);
        setEditBase(loaded);
        const thumbs = loaded.images
          ? loaded.images.split('\n')
          : (detail.photos || []).map((p) => p.url).filter((url): url is string => Boolean(url));
        if (thumbs.length) setEditThumbs(thumbs);
      }
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setEditBusy(false);
    }
  }

  async function saveEdit() {
    if (!edit?.sku) return;
    const price_cents = editPrice.trim() ? Math.round(Number(editPrice) * 100) : null;
    const quantity = editQty.trim() !== editBase.qty.trim() && editQty.trim() ? Math.round(Number(editQty)) : null;
    const title = editTitle.trim() !== editBase.title.trim() ? (editTitle.trim() || null) : null;
    const description = editDesc !== editBase.desc ? editDesc : null;
    const condition_note = editNote !== editBase.note ? (editNote.trim() || null) : null;
    const aspects = editAspects.trim() !== editBase.aspects.trim() ? parseAspects(editAspects) : null;
    const image_urls = editImages !== editBase.images
      ? editImages.split(/\n+/).map((s) => s.trim()).filter(Boolean)
      : null;
    setEditBusy(true);
    setError('');
    try {
      if (edit.live) {
        const { status, json } = await call(accessToken, {
          action: 'patch',
          channel,
          sku: edit.sku,
          offer_sku: edit.offer_sku,
          offer_id: edit.offer_id,
          account_id: edit.account_id,
          product_id: edit.product_id,
          price_cents,
          quantity,
          title,
          description,
          condition: editCondition || null,
          condition_note,
          item_id: edit.item_id,
          aspects,
          image_urls,
          shipping_mode: channel === 'ebay' && editShip && editShip !== editShipBase ? editShip : null,
          sync_floor_ask: true,
        });
        const body = unwrap(status, json) as { warning?: string; shipping_warning?: string; channels?: { channel: string; ok?: boolean; error?: string | null; manual?: boolean }[] };
        const failed = (body.channels || []).filter((row) => row.ok === false).map((row) => `${row.channel}: ${row.error || 'failed'}`);
        const manual = (body.channels || []).some((row) => row.manual);
        const extra = [body.warning, body.shipping_warning, failed.join(' · '), manual ? 'Depop needs a manual update.' : ''].filter(Boolean).join(' ');
        const synced = (body.channels || []).length > 0;
        setNotice(extra ? `Saved. ${extra}` : synced ? 'Saved. Floor ask updated, and every live channel was synced from it.' : 'Saved.');
      } else {
        const { status, json } = await call(accessToken, {
          action: 'board_floor_save',
          channel,
          sku: edit.sku,
          title: editTitle.trim() || null,
          description: editDesc,
          price_cents,
          condition: editCondition,
          condition_note: editNote,
          shipping_mode: channel === 'ebay' ? editShip : null,
        });
        unwrap(status, json);
        setNotice('Saved on Floor. Push the row when you want it live on this marketplace.');
      }
      setEdit(null);
      await loadCatalog({ force: true });
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setEditBusy(false);
    }
  }

  function receiptHtml(rows: SoldRow[]) {
    return rows.map((row) => `<section class="sheet"><h1>Open Box Industries</h1>
      <p class="meta">Receipt ${escapeHtml(row.receipt_no || '—')} · ${escapeHtml(stamp(row.sold_at, true))}<br>${escapeHtml(meta.fee.replace(' fees', ''))}${row.order_no ? ` · Order ${escapeHtml(row.order_no)}` : ''}${row.buyer_name ? `<br>${escapeHtml(row.buyer_name)}` : ''}</p>
      <table><tr><td><strong>${escapeHtml(row.title)}</strong><div class="meta">SKU ${escapeHtml(row.sku || '—')}${row.condition ? ` · ${escapeHtml(row.condition)}` : ''}</div></td><td class="num">${escapeHtml(money(row.price_cents))}</td></tr></table>
      <div class="totals"><div><span>Item</span><span>${escapeHtml(money(row.price_cents))}</span></div>
      ${row.shipping_cents ? `<div><span>Buyer shipping</span><span>${escapeHtml(money(row.shipping_cents))}</span></div>` : ''}
      <div class="strong"><span>Sale price</span><span>${escapeHtml(money(row.price_cents + (row.shipping_cents || 0)))}</span></div></div>
      <p class="legal">7-DAY EXCHANGE ONLY. No returns and no refunds. With this receipt, you may exchange the item or take store credit within 7 days of sale. Goods are sold AS-IS, WHERE-IS, with all faults. Keep this receipt.</p>
    </section>`).join('');
  }

  function invoiceHtml(rows: SoldRow[]) {
    const totals = rows.reduce((sum, row) => ({
      price: sum.price + row.price_cents,
      fee: sum.fee + row.fee_cents,
      label: sum.label + row.label_cents,
      cost: sum.cost + row.cost_cents,
      net: sum.net + (row.net_cents || 0),
    }), { price: 0, fee: 0, label: 0, cost: 0, net: 0 });
    const lines = rows.map((row) => `<tr><td>${escapeHtml(row.sku || '')}<div class="meta">${escapeHtml(row.title)}</div></td><td>${escapeHtml(row.order_no || row.receipt_no || '')}</td><td class="num">${escapeHtml(money(row.price_cents))}</td><td class="num">${escapeHtml(money(row.fee_cents))}</td><td class="num">${escapeHtml(money(row.label_cents))}</td><td class="num">${escapeHtml(money(row.cost_cents))}</td><td class="num">${row.net_cents == null ? '—' : escapeHtml(money(row.net_cents))}</td></tr>`).join('');
    return `<h1>Fee invoice · ${escapeHtml(meta.title)}</h1><p class="meta">${escapeHtml(quarters.find((q) => q.id === quarter)?.label || quarter)} · ${rows.length} sale${rows.length === 1 ? '' : 's'}</p>
      <table><thead><tr><th>Item</th><th>Order</th><th class="num">Sale</th><th class="num">Fees</th><th class="num">Label</th><th class="num">Item cost</th><th class="num">Net</th></tr></thead><tbody>${lines}</tbody>
      <tfoot><tr><td colspan="2"><strong>Total</strong></td><td class="num">${escapeHtml(money(totals.price))}</td><td class="num">${escapeHtml(money(totals.fee))}</td><td class="num">${escapeHtml(money(totals.label))}</td><td class="num">${escapeHtml(money(totals.cost))}</td><td class="num">${escapeHtml(money(totals.net))}</td></tr></tfoot></table>
      <p class="meta">Net is sale price + buyer shipping − marketplace fees − shipping label − card processing − item cost, the same figure as the ledger profit.</p>`;
  }

  function exportSold(rows: SoldRow[]) {
    downloadCsv(`${channel}-${quarter}-sales.csv`, [
      ['SKU', 'Title', 'Order', 'Receipt', 'Date', 'Sale price', 'Buyer shipping', 'Fees', 'Label', 'Item cost', 'Net'],
      ...rows.map((row) => [
        row.sku || '', row.title, row.order_no, row.receipt_no, stamp(row.sold_at, true),
        (row.price_cents / 100).toFixed(2), (row.shipping_cents / 100).toFixed(2),
        (row.fee_cents / 100).toFixed(2), (row.label_cents / 100).toFixed(2),
        (row.cost_cents / 100).toFixed(2), row.net_cents == null ? '' : (row.net_cents / 100).toFixed(2),
      ]),
    ]);
  }

  async function openAdd() {
    setShowAdd(true);
    setEditBusy(true);
    setError('');
    try {
      const { status, json } = await call(accessToken, { action: 'eligible', channel, query: eligibleQuery, limit: 40 });
      const body = unwrap(status, json) as { items?: { sku: string; title: string | null; ask_cents: number | null }[] };
      setEligible(body.items || []);
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setEditBusy(false);
    }
  }

  async function publishOne(sku: string) {
    setEditBusy(true);
    setError('');
    try {
      const { status, json } = await call(accessToken, { action: 'publish', channel, sku });
      const body = unwrap(status, json) as { warning?: string; url?: string; message?: string; needs_confirm?: boolean };
      if (body.needs_confirm) setNotice(body.message || 'Amazon preview is clean. Confirm the live create from the Amazon queue.');
      else setNotice(body.warning ? `Listed. ${body.warning}` : body.url ? `Listed — ${body.url}` : 'Listed.');
      setShowAdd(false);
      await loadCatalog({ force: true });
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setEditBusy(false);
    }
  }

  async function openMigrate() {
    setShowMigrate(true);
    setEditBusy(true);
    try {
      const { status, json } = await call(accessToken, { action: 'migrate_candidates', limit: 50 });
      const body = unwrap(status, json) as { items?: { sku: string; listing_id: string; title: string }[] };
      setLegacy(body.items || []);
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setEditBusy(false);
    }
  }

  async function migrateOne(listingId: string) {
    if (!window.confirm(`Migrate listing ${listingId} into Inventory API? The live listing should stay the same.`)) return;
    setEditBusy(true);
    setError('');
    try {
      const { status, json } = await call(accessToken, { action: 'migrate_one', listing_id: listingId });
      unwrap(status, json);
      setNotice(`Migrated ${listingId}.`);
      await openMigrate();
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setEditBusy(false);
    }
  }

  const jobActive = job?.status === 'running' || job?.status === 'queued';
  const feeLabel = meta.fee;
  const showConnect = !connected && tab !== 'sold';
  const accountLine = accounts.length
    ? accounts.map((a) => `${a.username || 'account'} ${a.error ? 'failed' : a.live_count ?? 0}`).join(' · ')
    : '';

  return (
    <div className="mboard">
      <header className="mboard-head">
        <div>
          <div className="eyebrow">MARKETPLACE</div>
          <h1>{meta.title}</h1>
          {accountLine ? <p className="mboard-accounts">{accountLine}{lastSynced ? ` · synced ${stamp(lastSynced, true)}` : ''}</p> : null}
        </div>
        <div className="mboard-head-side">
          <label className="mboard-quarter">
            <span>Quarter</span>
            <select value={quarter} onChange={(e) => { setQuarter(e.target.value); setPage(0); setSelected(new Set()); }}>
              {quarters.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
            </select>
          </label>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => { setError(''); setNotice(''); void loadCatalog({ force: true }); void loadQuarter(quarter); }}>Refresh</button>
            <button type="button" onClick={() => void openAdd()} disabled={!connected}>Add listing</button>
            {channel === 'ebay' && <button type="button" className="secondary" onClick={() => void openMigrate()}>Migrate legacy eBay</button>}
          </div>
        </div>
      </header>

      <div className="mboard-stats">
        <article className="mboard-card">
          <span>Gross sales</span>
          <strong>{!stats ? (quarterBusy ? '…' : money(0)) : money(stats.gross_cents)}</strong>
          <small>{stats ? `${stats.orders} order${stats.orders === 1 ? '' : 's'} this quarter` : ' '}</small>
        </article>
        <article className="mboard-card neg">
          <span>{feeLabel}</span>
          <strong>{!stats ? (quarterBusy ? '…' : money(0)) : stats.fee_cents ? `−${money(stats.fee_cents)}` : money(0)}</strong>
          <small>{stats && stats.gross_cents ? `${stats.fee_pct.toFixed(1)}% of gross` : 'marketplace fees'}</small>
        </article>
        <article className="mboard-card neg">
          <span>Shipping cost</span>
          <strong>{!stats ? (quarterBusy ? '…' : money(0)) : stats.ship_cents ? `−${money(stats.ship_cents)}` : money(0)}</strong>
          <small>labels paid by you</small>
        </article>
        <article className="mboard-card pos">
          <span>Profit</span>
          <strong>{!stats ? (quarterBusy ? '…' : money(0)) : money(stats.profit_cents)}</strong>
          <small>
            after fees, shipping & item cost
            {channel === 'ebay' && stats && stats.insertion_cents > 0 ? ` · includes ${money(stats.insertion_cents)} insertion & subscription` : ''}
          </small>
        </article>
      </div>
      {stats && stats.voided_count > 0 && (
        <p className="mboard-note">{stats.voided_count} voided this quarter — left out of gross, fees, and profit. Label cost on those sales still counts, same as Reports.</p>
      )}

      <label className="mboard-search">
        <span className="sr">Search</span>
        <input
          value={query}
          placeholder={channel === 'amazon' ? 'Search all tabs — SKU, title, UPC, ASIN…' : 'Search all tabs — SKU, title, UPC…'}
          onChange={(e) => { setQuery(e.target.value); setPage(0); }}
        />
      </label>

      {error && <div className="alert" role="alert">{shortError(error)}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {warnings.length > 0 && <div className="alert" role="status">{warnings.join(' · ')}</div>}
      {jobActive && (
        <div className="mboard-progress" role="status">
          <div className="mboard-progress-bar"><span style={{ width: `${Math.min(100, Math.round(((job?.progress?.current || 0) / Math.max(1, job?.progress?.total || 1)) * 100))}%` }} /></div>
          <p>{job?.progress?.message || 'Working…'}</p>
        </div>
      )}

      <section className="mboard-panel">
        <div className="mboard-tabs" role="tablist">
          {([
            ['listed', 'Currently listed', listed.length],
            ['not_listed', 'Not listed', notListed.length],
            ['sold', 'Sold', sold.length],
          ] as const).map(([id, label, count]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => { setTab(id); setPage(0); setSelected(new Set()); }}>
              {label} <em>{catalogBusy && id !== 'sold' ? '…' : quarterBusy && id === 'sold' ? '…' : count}</em>
            </button>
          ))}
        </div>

        {showConnect ? (
          <div className="mboard-empty">
            <strong>Connect TikTok</strong>
            <p>{connectMessage || 'TikTok Shop is waiting on Partner keys. The page is ready — listings, push, and sales will fill in after you authorize.'}</p>
            <a className="mboard-connect" href="/?page=marketplaces">Connect TikTok in Marketplaces</a>
          </div>
        ) : (
          <>
            {selected.size > 0 && (
              <div className="mboard-selectbar">
                <div>
                  <strong>{selected.size} selected</strong>
                  {selected.size < filtered.length && <button type="button" className="text-button" onClick={selectAllFiltered}>Select all {filtered.length}</button>}
                  <button type="button" className="text-button" onClick={() => setSelected(new Set())}>Clear</button>
                </div>
                <div className="actions">
                  {tab === 'listed' && <>
                    <button type="button" className="secondary" disabled={jobActive || !pickedCatalog.length} onClick={() => {
                      if (window.confirm(`Delist ${pickedCatalog.length} on ${meta.title}? ${pickedCatalog.length === 1 ? 'The unit stays' : 'Units stay'} available in Floor and move to Not listed.`)) void startJob('delist', pickedCatalog);
                    }}>Delist</button>
                    <button type="button" className="secondary" disabled={jobActive || !pickedCatalog.length} onClick={() => {
                      setUseListedPrice(pickedCatalog.length > 1);
                      setSoldPrice(pickedCatalog.length === 1 && pickedCatalog[0].price_cents != null ? (pickedCatalog[0].price_cents / 100).toFixed(2) : '');
                      setMarkSold(pickedCatalog);
                    }}>Mark sold</button>
                    <button type="button" className="mboard-danger" disabled={jobActive || !pickedCatalog.length} onClick={() => setConfirmDelete(pickedCatalog)}>Delete</button>
                  </>}
                  {tab === 'not_listed' && <>
                    <button type="button" className="mboard-push" disabled={jobActive || !pickedCatalog.some((row) => !row.blocked)} onClick={() => {
                      const rows = pickedCatalog.filter((row) => !row.blocked);
                      if (!rows.length) return;
                      if (window.confirm(`List ${rows.length} on ${meta.title}? They publish one at a time, about 10 seconds apart.`)) void startJob('list', rows);
                    }}>List selected</button>
                    <button type="button" className="mboard-danger" disabled={jobActive || !pickedCatalog.length} onClick={() => setConfirmDelete(pickedCatalog)}>Delete</button>
                  </>}
                  {tab === 'sold' && <>
                    <button type="button" className="secondary" disabled={!pickedSold.length} onClick={() => printDocument('Receipts', receiptHtml(pickedSold))}>Print receipts</button>
                    <button type="button" className="secondary" disabled={!pickedSold.length} onClick={() => printDocument('Fee invoice', invoiceHtml(pickedSold))}>Print fee invoice</button>
                    <button type="button" className="secondary" disabled={!pickedSold.length} onClick={() => exportSold(pickedSold)}>Export CSV</button>
                  </>}
                </div>
              </div>
            )}

            <div className="mboard-columns">
              <label className="mboard-check"><input ref={headRef} type="checkbox" checked={allVisible} onChange={togglePage} aria-label="Select rows on this page" /></label>
              <span>Photo</span><span>Item</span><span>Price</span>
              <span>{tab === 'sold' ? 'Fees & net' : 'Shipping'}</span>
              <span>{tab === 'sold' ? 'Docs' : 'Actions'}</span>
            </div>

            {((tab === 'sold' ? quarterBusy : catalogBusy) && visible.length === 0) ? (
              <div className="mboard-empty"><strong>Loading…</strong><p>Pulling {meta.title} from Floor and the live marketplace.</p></div>
            ) : visible.length === 0 ? (
              <div className="mboard-empty">
                <strong>{tab === 'listed' ? `No live ${meta.title} listings` : tab === 'not_listed' ? 'Nothing waiting to list' : `No ${meta.title} sales this quarter`}</strong>
                <p>
                  {tab === 'listed' && channel === 'amazon' && 'Amazon has no live offers right now. Ready units are on Not listed.'}
                  {tab === 'listed' && channel !== 'amazon' && 'Listings show up here as soon as the marketplace reports them live.'}
                  {tab === 'not_listed' && 'Units that are not live here show up here. Push is only available when that marketplace’s required fields are filled.'}
                  {tab === 'sold' && 'Sales for the quarter selected above show up here. Voided sales stay out, same as Reports.'}
                </p>
              </div>
            ) : visible.map((row) => {
              const catalog = 'live' in row ? row as CatalogRow : null;
              const sale = 'sale_id' in row ? row as SoldRow : null;
              return (
                <div className={`mboard-row${catalog?.blocked ? ' is-blocked' : ''}`} key={row.key}>
                  <label className="mboard-check"><input type="checkbox" checked={selected.has(row.key)} onChange={() => toggleKey(row.key)} aria-label={`Select ${row.sku || row.title}`} /></label>
                  <div className="mboard-photo">{row.photo_url ? <img src={row.photo_url} alt="" loading="lazy" decoding="async" /> : <span>No photo</span>}</div>
                  <div className="mboard-item">
                    <strong>{row.title}</strong>
                    <small>
                      {catalog && <>SKU {catalog.sku || '—'}{catalog.condition ? ` · ${catalog.condition}` : ''}{catalog.listed_at ? ` · listed ${stamp(catalog.listed_at)}` : ''}</>}
                      {sale && <>SKU {sale.sku || '—'}{sale.order_no ? ` · Order ${sale.order_no}` : ''}{sale.sold_at ? ` · ${stamp(sale.sold_at, true)}` : ''}</>}
                    </small>
                    {catalog?.blocked_reason && (
                      <small className="mboard-reason">
                        {catalog.blocked_reason}
                        {catalog.fix_section && <> · <a href={`/?page=inventory&inventoryTab=attention&section=${catalog.fix_section}`}>Fix in Inventory</a></>}
                      </small>
                    )}
                  </div>
                  <div className="mboard-price">{row.price_cents != null ? money(row.price_cents) : '—'}</div>
                  <div className="mboard-ship">
                    {catalog?.live && <span className={`mboard-tag ${catalog.shipping === 'free' ? 'free' : catalog.shipping === 'buyer' ? 'buyer' : 'unknown'}`}>{catalog.shipping === 'free' ? 'Free shipping' : catalog.shipping === 'buyer' ? 'Buyer pays' : 'Shipping unknown'}</span>}
                    {sale && <span className="mboard-fees">Fees {money(sale.fee_cents)} · Label {money(sale.label_cents)} · Net {sale.net_cents == null ? '—' : money(sale.net_cents)}</span>}
                  </div>
                  <div className="mboard-actions">
                    {catalog && <button type="button" className="secondary" onClick={() => void openEdit(catalog)}>Edit</button>}
                    {catalog && tab === 'not_listed' && (
                      <button type="button" className="mboard-push" disabled={jobActive || catalog.blocked || !catalog.sku} onClick={() => {
                        if (window.confirm(`Push SKU ${catalog.sku} live on ${meta.title}?`)) void startJob('list', [catalog]);
                      }}>Push</button>
                    )}
                    {sale && <>
                      <button type="button" className="secondary" onClick={() => printDocument(`Receipt ${sale.receipt_no}`, receiptHtml([sale]))}>Receipt</button>
                      <button type="button" className="secondary" onClick={() => printDocument(`Invoice ${sale.order_no || sale.receipt_no}`, invoiceHtml([sale]))}>Invoice</button>
                    </>}
                  </div>
                </div>
              );
            })}

            {filtered.length > PAGE && (
              <div className="mboard-pager">
                <button type="button" className="secondary" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</button>
                <span>Page {safePage + 1} of {pages} · {filtered.length} {query.trim() ? 'matches' : 'rows'}</span>
                <button type="button" className="secondary" disabled={safePage >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            )}
          </>
        )}
      </section>

      {edit && (
        <div className="mboard-modal">
          <div className="mboard-modal-card">
            <h2>Edit {edit.sku}</h2>
            {error && <div className="alert" role="alert">{shortError(error)}</div>}
            <p className="hint">{edit.live ? 'Price is the Floor ask. A new ask reprices every live channel. Title, photos, and condition push only when you change them. On eBay, changing shipping switches the live business policy. Unknown shipping stays as it is.' : 'This unit is not live here. Save updates Floor. Push lists it once the required fields are filled.'}</p>
            {editThumbs.length > 0 && <div className="mboard-thumbs">{editThumbs.slice(0, 8).map((url) => <img key={url} src={url} alt="" loading="lazy" decoding="async" />)}</div>}
            <label>Title<input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} /></label>
            <label>Description<textarea rows={4} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} /></label>
            <div className="mboard-edit-grid">
              <label>Floor ask<input value={editPrice} onChange={(e) => setEditPrice(e.target.value)} inputMode="decimal" /></label>
              <label>Qty<input value={editQty} onChange={(e) => setEditQty(e.target.value)} inputMode="numeric" /></label>
              <label>Condition<select value={editCondition} onChange={(e) => setEditCondition(e.target.value)}>
                <option value=""> </option>
                {[...new Set([...CONDITIONS, editCondition].filter(Boolean))].map((c) => <option key={c} value={c}>{c}</option>)}
              </select></label>
              {channel === 'ebay' && <label>Shipping<select value={editShip} onChange={(e) => setEditShip(e.target.value)}>
                {editShipBase === '' && <option value="">Shipping unknown — leave unchanged</option>}
                <option value="calculated">Buyer pays</option>
                <option value="free">Free shipping</option>
              </select></label>}
            </div>
            <label>Condition note<textarea rows={2} value={editNote} onChange={(e) => setEditNote(e.target.value)} /></label>
            {channel === 'ebay' && <label>Item specifics <small>Name: value</small><textarea rows={4} value={editAspects} onChange={(e) => setEditAspects(e.target.value)} /></label>}
            {edit.live && channel === 'ebay' && <label>Photo URLs <small>https only, real unit photos</small><textarea rows={3} value={editImages} onChange={(e) => setEditImages(e.target.value)} /></label>}
            <div className="actions">
              <button type="button" disabled={editBusy} onClick={() => void saveEdit()}>Save</button>
              <button type="button" className="secondary" onClick={() => setEdit(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {markSold && (
        <div className="mboard-modal">
          <div className="mboard-modal-card">
            <h2>Mark sold</h2>
            {error && <div className="alert" role="alert">{shortError(error)}</div>}
            <p className="hint">Records a {meta.title} sale in Floor and pulls the unit off every other channel, same as a marketplace sale.</p>
            {markSold.length > 1 && <label className="mboard-inline"><input type="checkbox" checked={useListedPrice} onChange={(e) => setUseListedPrice(e.target.checked)} /> Use each listing’s price</label>}
            {(!useListedPrice || markSold.length === 1) && <label>Sale price<input value={soldPrice} onChange={(e) => setSoldPrice(e.target.value)} inputMode="decimal" /></label>}
            <div className="actions">
              <button type="button" disabled={jobActive} onClick={() => {
                const override = soldPrice.trim() ? Math.round(Number(soldPrice) * 100) : null;
                if ((!useListedPrice || markSold.length === 1) && (override == null || !Number.isFinite(override))) {
                  setError('Enter a sale price.');
                  return;
                }
                void startJob('mark_sold', markSold, (row) => (useListedPrice && markSold.length > 1 ? row.price_cents : override));
                setMarkSold(null);
              }}>Record sale</button>
              <button type="button" className="secondary" onClick={() => setMarkSold(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="mboard-modal">
          <div className="mboard-modal-card">
            <h2>Delete {confirmDelete.length} unit{confirmDelete.length === 1 ? '' : 's'}?</h2>
            <p className="hint">This removes {confirmDelete.length === 1 ? 'it' : 'them'} from Floor and ends {confirmDelete.length === 1 ? 'it' : 'them'} on every channel. Units with a sale that has not been voided are refused.</p>
            <div className="actions">
              <button type="button" className="mboard-danger" disabled={jobActive} onClick={() => { void startJob('delete', confirmDelete); setConfirmDelete(null); }}>Delete {confirmDelete.length}</button>
              <button type="button" className="secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="mboard-modal">
          <div className="mboard-modal-card">
            <h2>Add listing</h2>
            {error && <div className="alert" role="alert">{shortError(error)}</div>}
            <label>Search<input value={eligibleQuery} onChange={(e) => setEligibleQuery(e.target.value)} /></label>
            <button type="button" className="secondary" onClick={() => void openAdd()}>Search Floor</button>
            <div className="mboard-eligible">
              {eligible.map((row) => (
                <div key={row.sku}>
                  <span>SKU {row.sku} · {row.title} · {row.ask_cents != null ? money(row.ask_cents) : '—'}</span>
                  <button type="button" disabled={editBusy} onClick={() => void publishOne(row.sku)}>Publish</button>
                </div>
              ))}
              {!eligible.length && <p className="hint">No eligible units in this search.</p>}
            </div>
            <button type="button" className="secondary" onClick={() => setShowAdd(false)}>Close</button>
          </div>
        </div>
      )}

      {showMigrate && (
        <div className="mboard-modal">
          <div className="mboard-modal-card">
            <h2>Migrate legacy eBay</h2>
            {error && <div className="alert" role="alert">{shortError(error)}</div>}
            <p className="hint">Trading-era listings Floor knows about but Inventory API does not. Migrating keeps the live listing.</p>
            <div className="mboard-eligible">
              {legacy.map((row) => (
                <div key={row.listing_id}>
                  <span>{row.title} · SKU {row.sku} · Item {row.listing_id}</span>
                  <button type="button" className="secondary" disabled={editBusy} onClick={() => void migrateOne(row.listing_id)}>Migrate</button>
                </div>
              ))}
              {!legacy.length && <p className="hint">No legacy candidates.</p>}
            </div>
            <button type="button" className="secondary" onClick={() => setShowMigrate(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
