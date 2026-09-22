import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { loadStoreSetting, setStoreSetting } from "@floor/cloud";
import { usePos } from "../pos-context";

type Branding = {
  storeName: string;
  address: string;
  phone: string;
  headerMessage: string;
  footerMessage: string;
  legal: string;
  returnPolicy: string;
  logoUrl: string;
  showSku: boolean;
  showCondition: boolean;
  showClerk: boolean;
  showPoints: boolean;
  reviewUrl: string;
  paperPreview: "roll80" | "letter";
};

const DEFAULTS: Branding = {
  storeName: "",
  address: "",
  phone: "",
  headerMessage: "Thank you for shopping with us",
  footerMessage: "",
  legal: "",
  returnPolicy: "",
  logoUrl: "",
  showSku: true,
  showCondition: true,
  showClerk: true,
  showPoints: true,
  reviewUrl: "",
  paperPreview: "roll80",
};

export function ReceiptDesignerScreen() {
  const { rewards, settings, saveSettings } = usePos();
  const [branding, setBranding] = useState<Branding>({
    ...DEFAULTS,
    storeName: rewards.storeDisplayName,
    reviewUrl: settings.reviewUrl,
    legal: settings.receiptLegal,
  });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const raw = await loadStoreSetting("receipt_branding");
        if (!raw) return;
        const parsed =
          typeof raw === "string"
            ? (JSON.parse(raw) as Branding)
            : (raw as Branding);
        setBranding((prev) => ({ ...prev, ...parsed }));
      } catch {
        /* migration may not have landed */
      }
    })();
  }, []);

  function patch<K extends keyof Branding>(key: K, value: Branding[K]) {
    setBranding((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setError("");
    setMsg("");
    try {
      await setStoreSetting("receipt_branding", branding);
      if (branding.storeName.trim()) {
        await setStoreSetting("display_name", branding.storeName.trim());
      }
      await saveSettings({
        ...settings,
        reviewUrl: branding.reviewUrl || settings.reviewUrl,
        receiptLegal: branding.legal || settings.receiptLegal,
        paperKind: branding.paperPreview === "letter" ? "letter" : settings.paperKind,
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

  return (
    <section className="page grid">
      <div className="row">
        <h1>Receipt designer</h1>
        <Link to="/settings">← Settings</Link>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {msg ? <p>{msg}</p> : null}
      <div className="card grid">
        <label>
          Store name
          <input value={branding.storeName} onChange={(e) => patch("storeName", e.target.value)} />
        </label>
        <label>
          Address
          <input value={branding.address} onChange={(e) => patch("address", e.target.value)} />
        </label>
        <label>
          Phone
          <input value={branding.phone} onChange={(e) => patch("phone", e.target.value)} />
        </label>
        <label>
          Header message
          <input value={branding.headerMessage} onChange={(e) => patch("headerMessage", e.target.value)} />
        </label>
        <label>
          Footer message
          <input value={branding.footerMessage} onChange={(e) => patch("footerMessage", e.target.value)} />
        </label>
        <label>
          Return policy
          <textarea rows={3} value={branding.returnPolicy} onChange={(e) => patch("returnPolicy", e.target.value)} />
        </label>
        <label>
          Legal
          <textarea rows={4} value={branding.legal} onChange={(e) => patch("legal", e.target.value)} />
        </label>
        <label>
          Logo URL
          <input value={branding.logoUrl} onChange={(e) => patch("logoUrl", e.target.value)} />
        </label>
        <label>
          Review URL
          <input value={branding.reviewUrl} onChange={(e) => patch("reviewUrl", e.target.value)} />
        </label>
        <label>
          Paper preview
          <select
            value={branding.paperPreview}
            onChange={(e) => patch("paperPreview", e.target.value as Branding["paperPreview"])}
          >
            <option value="roll80">80 mm roll</option>
            <option value="letter">Letter</option>
          </select>
        </label>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input type="checkbox" checked={branding.showSku} onChange={(e) => patch("showSku", e.target.checked)} />
          Show SKU
        </label>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={branding.showCondition}
            onChange={(e) => patch("showCondition", e.target.checked)}
          />
          Show condition
        </label>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input type="checkbox" checked={branding.showClerk} onChange={(e) => patch("showClerk", e.target.checked)} />
          Show clerk
        </label>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={branding.showPoints}
            onChange={(e) => patch("showPoints", e.target.checked)}
          />
          Show points
        </label>
      </div>
      <button type="button" className="primary" onClick={() => void save()}>
        Save branding
      </button>
      <div className="card">
        <strong>Preview</strong>
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace", fontSize: "0.85rem" }}>
          {`${branding.storeName || "Store"}\n${branding.address}\n${branding.phone}\n\n${branding.headerMessage}\n----------------\nITEM  $12.00\nTAX    $0.87\nTOTAL $12.87\n----------------\n${branding.footerMessage}\n${branding.returnPolicy}\n${branding.legal}`}
        </pre>
      </div>
    </section>
  );
}
