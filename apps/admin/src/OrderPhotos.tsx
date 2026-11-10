import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { locationParts } from './locationOrder';
import { carrierTrackUrl, trackingTail, type StageOrder } from './orderStage';
import { derivativePath, photoDisplayUrl, photoKind, type UnitPhoto } from './unitPhotos';

type Sign = (paths: string[]) => Promise<Record<string, string>>;

function srcFor(photo: UnitPhoto, urls: Record<string, string>, full: boolean) {
  return photoDisplayUrl(photo.path, urls, full ? 1200 : 400);
}

function OrderPhotoImg({ photo, urls, full, sign, eager }: {
  photo: UnitPhoto;
  urls: Record<string, string>;
  full: boolean;
  sign: Sign;
  eager?: boolean;
}) {
  const preferred = srcFor(photo, urls, full);
  const [src, setSrc] = useState(preferred);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    setSrc(preferred);
    setGaveUp(false);
  }, [preferred, photo.path]);
  if (!src) return <span className="order-photo-wait">Loading photo…</span>;
  return (
    <img
      src={src}
      alt=""
      loading={eager ? 'eager' : 'lazy'}
      onError={() => {
        if (gaveUp) return;
        const original = urls[photo.path];
        if (original && original !== src) {
          setSrc(original);
          return;
        }
        void sign([photo.path]).then((next) => {
          const url = next[photo.path];
          if (url && url !== src) setSrc(url);
          else setGaveUp(true);
        });
      }}
    />
  );
}

export function OrderPhotoCarousel({ photos, urls, sign }: { photos: UnitPhoto[]; urls: Record<string, string>; sign: Sign }) {
  const [index, setIndex] = useState(0);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [full, setFull] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const checked = useRef(new Set<string>());
  const [settled, setSettled] = useState(0);
  const known = { ...urls, ...extra };
  const photoKey = photos.map((photo) => photo.id).join(',');

  useEffect(() => {
    setIndex(0);
    setFull(false);
    checked.current = new Set();
  }, [photoKey]);

  useEffect(() => {
    const pending = photos.filter((photo) => {
      const thumb = derivativePath(photo.path, 400);
      const have = Boolean((thumb && urls[thumb]) || urls[photo.path]);
      return !have && !checked.current.has(photo.path);
    });
    if (!pending.length) {
      setSettled((n) => n || 1);
      return;
    }
    let alive = true;
    const thumbs = pending
      .map((photo) => derivativePath(photo.path, 400))
      .filter((path): path is string => path != null);
    void sign(thumbs).then(async (next) => {
      if (!alive) return;
      const still = pending
        .filter((photo) => {
          const thumb = derivativePath(photo.path, 400);
          return !(thumb && next[thumb]);
        })
        .map((photo) => photo.path);
      const originals = still.length ? await sign(still) : {};
      if (!alive) return;
      for (const photo of pending) checked.current.add(photo.path);
      setExtra((prev) => ({ ...prev, ...next, ...originals }));
      setSettled((n) => n + 1);
    });
    return () => { alive = false; };
  }, [photoKey, sign, urls]);

  useEffect(() => {
    const photo = photos[index];
    if (!photo || !settled) return;
    const thumb = derivativePath(photo.path, 400);
    const detail = derivativePath(photo.path, 1200);
    const thumbReady = Boolean(thumb && (known[thumb] || checked.current.has(thumb) || urls[thumb]));
    if (!thumbReady && thumb) return;
    const hasThumb = Boolean(thumb && known[thumb]);
    const want = [
      (full || !hasThumb) && detail && !known[detail] ? detail : '',
      (full || !hasThumb) && !known[detail || ''] && !known[photo.path] ? photo.path : '',
    ].filter(Boolean);
    if (!want.length) return;
    let alive = true;
    void sign(want).then((next) => { if (alive) setExtra((prev) => ({ ...prev, ...next })); });
    return () => { alive = false; };
    // known updates after this sign; including it would re-sign the same paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, full, photoKey, settled, sign]);

  function go(next: number) {
    const i = Math.max(0, Math.min(photos.length - 1, next));
    setIndex(i);
    const el = scroller.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  }

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / Math.max(el.clientWidth, 1));
    setIndex(Math.max(0, Math.min(photos.length - 1, i)));
  }

  if (!photos.length) {
    return <div className="order-photo-empty">No photos on this item</div>;
  }

  const current = photos[index] || photos[0];

  return (
    <div className="order-photos">
      <div className="order-photo-frame">
        <div className="order-photo-scroller" ref={scroller} onScroll={onScroll}>
          {photos.map((photo, i) => (
            <button key={photo.id} type="button" className="order-photo-slide" onClick={() => { setIndex(i); setFull(true); }} aria-label={`Open ${photoKind(photo)} ${i + 1}`}>
              <OrderPhotoImg photo={photo} urls={known} full={i === index && !srcFor(photo, known, false)} sign={sign} eager={i === index} />
            </button>
          ))}
        </div>
        <span className="order-photo-tag">{photoKind(current)}</span>
        <span className="order-photo-count">{index + 1} / {photos.length}</span>
        {photos.length > 1 && (
          <>
            <button type="button" className="order-photo-arrow prev" aria-label="Previous photo" onClick={() => go(index - 1)}>‹</button>
            <button type="button" className="order-photo-arrow next" aria-label="Next photo" onClick={() => go(index + 1)}>›</button>
          </>
        )}
        <div className="order-photo-dots" aria-hidden="true">
          {photos.map((photo, i) => <i key={photo.id} className={i === index ? 'on' : ''} />)}
        </div>
      </div>
      <div className="order-photo-thumbs" role="list">
        {photos.map((photo, i) => (
          <button key={photo.id} type="button" role="listitem" className={i === index ? 'on' : ''} aria-label={`${photoKind(photo)} ${i + 1}`} onClick={() => go(i)}>
            <OrderPhotoImg photo={photo} urls={known} full={false} sign={sign} />
          </button>
        ))}
      </div>
      {full && createPortal(
        <OrderPhotoFull
          photos={photos}
          index={index}
          urls={known}
          onIndex={go}
          onClose={() => setFull(false)}
        />,
        document.body,
      )}
    </div>
  );
}

function OrderPhotoFull({ photos, index, urls, onIndex, onClose }: {
  photos: UnitPhoto[];
  index: number;
  urls: Record<string, string>;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const photo = photos[index];
  const src = photo ? srcFor(photo, urls, true) : '';
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);
  const drag = useRef<{ x: number; y: number; pinched: boolean } | null>(null);

  useEffect(() => { setScale(1); setPan({ x: 0, y: 0 }); }, [index, src]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') onIndex(index + 1);
      if (e.key === 'ArrowLeft') onIndex(index - 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, onClose, onIndex]);

  function pointerDown(e: ReactPointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale };
      if (drag.current) drag.current.pinched = true;
    } else {
      drag.current = { x: e.clientX, y: e.clientY, pinched: false };
    }
  }
  function pointerMove(e: ReactPointerEvent) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const next = Math.min(4, Math.max(1, pinch.current.scale * (dist / pinch.current.dist)));
      setScale(next);
      if (next === 1) setPan({ x: 0, y: 0 });
      if (drag.current) drag.current.pinched = true;
      return;
    }
    if (scale > 1) setPan((p) => ({ x: p.x + e.clientX - prev.x, y: p.y + e.clientY - prev.y }));
  }
  function pointerUp(e: ReactPointerEvent) {
    pointers.current.delete(e.pointerId);
    pinch.current = null;
    const start = drag.current;
    if (pointers.current.size === 0 && start && !start.pinched && scale === 1) {
      const dx = e.clientX - start.x;
      if (dx <= -48) onIndex(index + 1);
      else if (dx >= 48) onIndex(index - 1);
    }
    if (pointers.current.size === 0) drag.current = null;
    if (scale < 1.05) { setScale(1); setPan({ x: 0, y: 0 }); }
  }

  if (!photo) return null;
  return (
    <div className="order-photo-full" role="dialog" aria-modal="true" aria-label={`${index + 1} / ${photos.length} · ${photoKind(photo)}`}>
      <div className="order-photo-full-bar">
        <button type="button" onClick={onClose}>Done</button>
        <strong>{index + 1} / {photos.length} · {photoKind(photo)}</strong>
        <span />
      </div>
      <div
        className="order-zoom"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onDoubleClick={() => { setScale((s) => (s > 1 ? 1 : 2)); setPan({ x: 0, y: 0 }); }}
      >
        {src ? <img src={src} alt="" draggable={false} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }} onError={(e) => {
          const img = e.currentTarget;
          const original = photo ? urls[photo.path] : '';
          if (!original || img.dataset.fallback === '1' || img.src === original) return;
          img.dataset.fallback = '1';
          img.src = original;
        }} /> : <span>Loading photo…</span>}
        {photos.length > 1 && scale === 1 && (
          <>
            <button type="button" className="order-photo-arrow prev" aria-label="Previous photo" onClick={() => onIndex(index - 1)}>‹</button>
            <button type="button" className="order-photo-arrow next" aria-label="Next photo" onClick={() => onIndex(index + 1)}>›</button>
          </>
        )}
      </div>
      <p className="order-photo-hint">Swipe to see all photos · pinch to zoom</p>
      <div className="order-photo-thumbs light" role="list">
        {photos.map((item, i) => {
          const thumb = srcFor(item, urls, false) || (i === index ? srcFor(item, urls, true) : '');
          return (
            <button key={item.id} type="button" className={i === index ? 'on' : ''} aria-label={`${photoKind(item)} ${i + 1}`} onClick={() => onIndex(i)}>
              {thumb ? <img src={thumb} alt="" onError={(e) => {
                const img = e.currentTarget;
                const original = urls[item.path];
                if (!original || img.dataset.fallback === '1' || img.src === original) return;
                img.dataset.fallback = '1';
                img.src = original;
              }} /> : <span />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function OrderTitle({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" className={`order-title${open ? ' is-open' : ''}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      {title || 'Item'}
    </button>
  );
}

export function OrderFindRow({ sku, code, options, disabled, onChange, picker = 'select' }: {
  sku: string;
  code: string;
  options: { code: string }[];
  disabled?: boolean;
  onChange: (code: string) => void;
  /** Desktop orders open a list. Phone keeps the select. */
  picker?: 'select' | 'button';
}) {
  const parts = locationParts(code);
  const [openList, setOpenList] = useState(false);
  if (picker === 'button') {
    return (
      <div className="order-find">
        <div className={`order-pick-block${parts ? '' : ' missing'}`}>
          <small>Pick from</small>
          <button type="button" className="secondary" disabled={disabled || !options.length} aria-expanded={openList} aria-label={`Set pick location for SKU ${sku}`} onClick={() => setOpenList((v) => !v)}>
            {parts ? `Bay ${parts.bay} · ${parts.slot}` : 'Set location'}
          </button>
          {openList && (
            <div className="order-loc-list" role="listbox" aria-label={`Locations for SKU ${sku}`}>
              {options.map((location) => {
                const bit = locationParts(location.code);
                return <button type="button" key={location.code} role="option" aria-selected={location.code === code} onClick={() => { onChange(location.code); setOpenList(false); }}>{bit ? `Bay ${bit.bay} · ${bit.slot}` : location.code}</button>;
              })}
            </div>
          )}
        </div>
        <div className="order-sku-block">
          <small>SKU</small>
          <strong>{sku || '—'}</strong>
        </div>
      </div>
    );
  }
  return (
    <div className="order-find">
      <label className={`order-pick-block${parts ? '' : ' missing'}`}>
        <small>Pick from</small>
        <strong>{parts ? `Bay ${parts.bay} · ${parts.slot}` : 'Set location'}</strong>
        <select aria-label={`Set pick location for SKU ${sku}`} value={code} disabled={disabled || !options.length} onChange={(e) => onChange(e.target.value)}>
          <option value="">{parts ? 'Change location' : 'Set location'}</option>
          {options.map((location) => {
            const bit = locationParts(location.code);
            return <option key={location.code} value={location.code}>{bit ? `Bay ${bit.bay} · ${bit.slot}` : location.code}</option>;
          })}
        </select>
      </label>
      <div className="order-sku-block">
        <small>SKU</small>
        <strong>{sku || '—'}</strong>
      </div>
    </div>
  );
}

export function OrderFacts({ label, labeled, order, layout = 'desktop' }: { label: string; labeled: boolean; order: StageOrder; layout?: 'desktop' | 'app' }) {
  const [copied, setCopied] = useState(false);
  const href = carrierTrackUrl(order.tracking_number, order.carrier);
  const tail = trackingTail(order);
  async function copy() {
    const text = String(order.tracking_number || '').replace(/\s+/g, '');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  if (layout === 'app') {
    return (
      <div className="order-facts order-facts-app">
        <div className="order-facts-row">
          <span>Label</span>
          <strong className={labeled ? '' : 'warn'}>{label}</strong>
        </div>
        <div className="order-facts-row order-facts-track">
          <span>Tracking</span>
          <div className="order-facts-track-body">
            <strong>{tail || '—'}</strong>
            {order.tracking_number && (
              <span className="order-facts-track-actions">
                <button type="button" className="order-mini-btn" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
                {href && (
                  <a className="order-mini-btn" href={href} target="_blank" rel="noreferrer">Track</a>
                )}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="order-facts">
      <div><span>Label</span><strong className={labeled ? 'ok' : 'warn'}>{label}</strong></div>
      <div>
        <span>Tracking</span>
        <strong>
          {tail || '—'}
          {order.tracking_number && (
            <>
              {' '}
              <button type="button" className="order-copy" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
              {href && <> · <a href={href} target="_blank" rel="noreferrer">Track</a></>}
            </>
          )}
        </strong>
      </div>
    </div>
  );
}
