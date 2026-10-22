import { useEffect, useRef, useState } from 'react';
import {
  authErrorMessage,
  loadStoreSetting,
  loadStoreTaxRateBps,
  setStoreSetting,
  setStoreTaxRateBps,
} from '@floor/cloud';
import { RECEIPT_LEGAL } from './sale';

export type ReceiptBranding = {
  storeName?: string | null;
  headerMessage?: string | null;
  footerMessage?: string | null;
  legal?: string | null;
  qrHeader?: string | null;
  qrCodeDataUrl?: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: (next: {
    taxRateBps: number;
    storeDisplayName: string;
    receiptLegal: string;
    headerMessage: string | null;
    footerMessage: string | null;
    qrHeader: string | null;
    qrCodeDataUrl: string | null;
  }) => void;
};

const MAX_QR_BYTES = 400_000;

function parseBranding(raw: unknown): ReceiptBranding {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as ReceiptBranding;
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object') return raw as ReceiptBranding;
  return {};
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(file);
  });
}

export function RegisterSettingsModal({ open, onClose, onSaved }: Props) {
  const [taxPct, setTaxPct] = useState('');
  const [storeName, setStoreName] = useState('Open Box Industries');
  const [headerMessage, setHeaderMessage] = useState('');
  const [footerMessage, setFooterMessage] = useState('');
  const [legal, setLegal] = useState(RECEIPT_LEGAL);
  const [qrHeader, setQrHeader] = useState('');
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [brandingBase, setBrandingBase] = useState<ReceiptBranding>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError('');
    setMsg('');
    setLoading(true);
    void (async () => {
      try {
        const [bps, brandingRaw, displayName] = await Promise.all([
          loadStoreTaxRateBps(),
          loadStoreSetting('receipt_branding'),
          loadStoreSetting('display_name'),
        ]);
        const branding = parseBranding(brandingRaw);
        setBrandingBase(branding);
        setTaxPct(bps != null ? (bps / 100).toFixed(2) : '');
        const name =
          (typeof displayName === 'string' && displayName.replace(/^"|"$/g, '')) ||
          branding.storeName ||
          'Open Box Industries';
        setStoreName(String(name));
        setHeaderMessage(branding.headerMessage || '');
        setFooterMessage(branding.footerMessage || '');
        setLegal(branding.legal || RECEIPT_LEGAL);
        setQrHeader(branding.qrHeader || '');
        setQrCodeDataUrl(branding.qrCodeDataUrl || null);
      } catch (err) {
        setError(authErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  if (!open) return null;

  async function onPickQr(file: File | null) {
    if (!file) return;
    setError('');
    if (!file.type.startsWith('image/')) {
      setError('Upload an image file for the QR code.');
      return;
    }
    if (file.size > MAX_QR_BYTES) {
      setError('QR image must be under 400 KB.');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setQrCodeDataUrl(dataUrl);
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  async function save() {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const pct = Number(taxPct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Enter a tax rate between 0 and 100.');
      const bps = Math.round(pct * 100);
      const nextLegal = legal.trim() || RECEIPT_LEGAL;
      const nextName = storeName.trim() || 'Open Box Industries';
      const nextQrHeader = qrHeader.trim() || null;
      const branding: ReceiptBranding = {
        ...brandingBase,
        storeName: nextName,
        headerMessage: headerMessage.trim() || null,
        footerMessage: footerMessage.trim() || null,
        legal: nextLegal,
        qrHeader: nextQrHeader,
        qrCodeDataUrl: qrCodeDataUrl || null,
      };
      await setStoreTaxRateBps(bps);
      await setStoreSetting('receipt_branding', branding);
      await setStoreSetting('display_name', nextName);
      onSaved({
        taxRateBps: bps,
        storeDisplayName: nextName,
        receiptLegal: nextLegal,
        headerMessage: headerMessage.trim() || null,
        footerMessage: footerMessage.trim() || null,
        qrHeader: nextQrHeader,
        qrCodeDataUrl: qrCodeDataUrl || null,
      });
      setMsg('Saved.');
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Register settings">
      <div className="card grid">
        <h2>Register settings</h2>
        {loading ? <p className="muted">Loading…</p> : null}
        {!loading ? (
          <>
            <label>
              Tax percentage
              <input
                inputMode="decimal"
                value={taxPct}
                onChange={e => setTaxPct(e.target.value)}
                placeholder="7.25"
              />
            </label>
            <p className="muted">Used for in-store sales tax on this register.</p>
            <label>
              Store name on receipts
              <input value={storeName} onChange={e => setStoreName(e.target.value)} />
            </label>
            <label>
              Header line
              <input
                value={headerMessage}
                onChange={e => setHeaderMessage(e.target.value)}
                placeholder="Optional line under the store name"
              />
            </label>
            <label>
              Footer line
              <input
                value={footerMessage}
                onChange={e => setFooterMessage(e.target.value)}
                placeholder="Optional line above the legal text"
              />
            </label>
            <label>
              Receipt text
              <textarea rows={6} value={legal} onChange={e => setLegal(e.target.value)} />
            </label>
            <label>
              QR header
              <input
                value={qrHeader}
                onChange={e => setQrHeader(e.target.value)}
                placeholder="Text above the QR code on the receipt"
              />
            </label>
            <div className="register-qr-block">
              <span className="register-qr-label">Receipt QR code</span>
              <p className="muted">Printed at the bottom center of the receipt under the QR header.</p>
              {qrCodeDataUrl ? (
                <img className="register-qr-preview" src={qrCodeDataUrl} alt="Receipt QR preview" />
              ) : (
                <p className="muted">No QR uploaded yet.</p>
              )}
              <div className="row">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={e => {
                    const file = e.target.files?.[0] ?? null;
                    e.target.value = '';
                    void onPickQr(file);
                  }}
                />
                <button type="button" className="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
                  {qrCodeDataUrl ? 'Replace QR' : 'Upload QR'}
                </button>
                {qrCodeDataUrl ? (
                  <button type="button" className="secondary" disabled={busy} onClick={() => setQrCodeDataUrl(null)}>
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        {msg ? <p className="muted">{msg}</p> : null}
        <div className="row">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>Close</button>
          <button type="button" disabled={busy || loading} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
