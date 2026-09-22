import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { loadStoreSetting, setStoreSetting } from "@floor/cloud";
import { usePos } from "../pos-context";
import {
  DEFAULT_BRANDING,
  DEFAULT_LEGAL,
  charsPerLine,
  mergeBranding,
  receiptHtmlEmail,
  receiptText,
  type ReceiptBranding,
  type ReceiptPayload,
} from "../receipt";

const MOCK_SALE: ReceiptPayload = {
  receiptNo: "F-1042",
  soldAt: new Date().toLocaleString(),
  clerkName: "Alex",
  sku: "11116",
  title: "GE fridge",
  condition: "Good",
  priceCents: 17500,
  taxCents: 1269,
  totalCents: 18269,
  tender: "CARD · Visa •••• 4242",
  tenderDetails: {
    method: "CARD",
    cardBrand: "Visa",
    cardLast4: "4242",
  },
  discountCents: 2500,
  pointsEarned: 18,
  pointsRedeemed: 5,
  pointsBalance: 132,
  lines: [
    {
      sku: "11116",
      title: "GE top-freezer fridge",
      condition: "Good",
      priceCents: 15000,
      taxCents: 1088,
      listPriceCents: 17500,
    },
    {
      sku: "11120",
      title: "HDMI cable 6ft",
      condition: "New",
      priceCents: 2500,
      taxCents: 181,
      listPriceCents: 2500,
    },
  ],
};

type PreviewMode = "thermal80" | "email";

export function ReceiptDesignerScreen() {
  const { rewards, settings, saveSettings } = usePos();
  const [branding, setBranding] = useState<ReceiptBranding>(() =>
    mergeBranding({
      storeName: rewards.storeDisplayName || DEFAULT_BRANDING.storeName,
      reviewUrl: settings.reviewUrl || null,
      legal: settings.receiptLegal || DEFAULT_LEGAL,
    }),
  );
  const [mode, setMode] = useState<PreviewMode>("thermal80");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const raw = await loadStoreSetting("receipt_branding");
        if (!raw) return;
        const parsed =
          typeof raw === "string" ? (JSON.parse(raw) as ReceiptBranding) : (raw as ReceiptBranding);
        setBranding((prev) => mergeBranding({ ...prev, ...parsed }));
      } catch {
        /* migration may not have landed */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function setField<K extends keyof ReceiptBranding>(key: K, value: ReceiptBranding[K]) {
    setBranding((b) => ({ ...b, [key]: value }));
  }

  const payload = useMemo(
    () => ({
      ...MOCK_SALE,
      reviewUrl: branding.reviewUrl || null,
      legal: branding.legal || DEFAULT_LEGAL,
      branding,
    }),
    [branding],
  );

  const previewText = useMemo(() => receiptText(payload, charsPerLine("roll80"), branding), [payload, branding]);
  const previewHtml = useMemo(() => receiptHtmlEmail(payload, branding), [payload, branding]);

  async function save() {
    setError("");
    setMsg("");
    try {
      await setStoreSetting("receipt_branding", branding);
      if (String(branding.storeName || "").trim()) {
        await setStoreSetting("display_name", String(branding.storeName).trim());
      }
      await saveSettings({
        ...settings,
        reviewUrl: branding.reviewUrl || settings.reviewUrl,
        receiptLegal: branding.legal || settings.receiptLegal,
      });
      setMsg("Receipt branding saved.");
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} (receipt_branding needs register_ux migration)`
          : String(err),
      );
    }
  }

  if (loading) return <p className="page">Loading receipt designer…</p>;

  return (
    <section className="page grid">
      <div className="row">
        <h1 style={{ margin: 0 }}>Receipt designer</h1>
        <Link to="/settings">← Settings</Link>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {msg ? <p>{msg}</p> : null}

      <div className="row" style={{ alignItems: "flex-start", gap: "1.5rem", flexWrap: "wrap" }}>
        <div className="grid" style={{ flex: "1 1 320px", minWidth: 280 }}>
          <label>
            Store name
            <input value={branding.storeName || ""} onChange={(e) => setField("storeName", e.target.value)} />
          </label>
          <label>
            Logo URL
            <input value={branding.logoUrl || ""} onChange={(e) => setField("logoUrl", e.target.value || null)} />
          </label>
          <label>
            Address
            <textarea rows={2} value={branding.address || ""} onChange={(e) => setField("address", e.target.value)} />
          </label>
          <label>
            Phone
            <input value={branding.phone || ""} onChange={(e) => setField("phone", e.target.value)} />
          </label>
          <label>
            Header message
            <input
              value={branding.headerMessage || ""}
              onChange={(e) => setField("headerMessage", e.target.value || null)}
            />
          </label>
          <label>
            Footer message
            <input
              value={branding.footerMessage || ""}
              onChange={(e) => setField("footerMessage", e.target.value || null)}
            />
          </label>
          <label>
            Legal
            <textarea rows={5} value={branding.legal || ""} onChange={(e) => setField("legal", e.target.value)} />
          </label>
          <label>
            Return policy
            <textarea
              rows={3}
              value={branding.returnPolicy || ""}
              onChange={(e) => setField("returnPolicy", e.target.value || null)}
            />
          </label>
          <label>
            Google review QR URL
            <input value={branding.reviewUrl || ""} onChange={(e) => setField("reviewUrl", e.target.value || null)} />
          </label>
          <fieldset className="grid">
            <legend>Fields</legend>
            {(
              [
                ["showSku", "SKU"],
                ["showCondition", "Condition"],
                ["showClerk", "Clerk"],
                ["showDiscount", "Discount"],
                ["showPoints", "Points"],
                ["showTax", "Tax"],
                ["showTenderDetails", "Tender details"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="row" style={{ gap: "0.5rem" }}>
                <input
                  type="checkbox"
                  checked={branding[key] !== false}
                  onChange={(e) => setField(key, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <button type="button" className="primary" onClick={() => void save()}>
            Save branding
          </button>
        </div>

        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
          <div className="row" style={{ marginBottom: "0.75rem" }}>
            <button type="button" className={mode === "thermal80" ? "primary" : ""} onClick={() => setMode("thermal80")}>
              80mm thermal
            </button>
            <button type="button" className={mode === "email" ? "primary" : ""} onClick={() => setMode("email")}>
              Full-page / email
            </button>
          </div>
          {mode === "thermal80" ? (
            <pre
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
                lineHeight: 1.35,
                width: "48ch",
                maxWidth: "100%",
                whiteSpace: "pre-wrap",
                background: "#f7f7f5",
                border: "1px solid #ddd",
                padding: "12px",
                margin: 0,
              }}
            >
              {previewText}
            </pre>
          ) : (
            <div
              style={{ border: "1px solid #ddd", background: "#fff", padding: 8 }}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          )}
        </div>
      </div>
    </section>
  );
}
