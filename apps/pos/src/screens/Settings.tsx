import { useState } from "react";
import { usePos } from "../pos-context";
import { callFunction } from "../functions";
import { hasAdminPin, kioskPower, setAdminPin, verifyAdminPin } from "../local";
import { DEFAULT_LEGAL, type PaperKind } from "../receipt";
import { pairReader, unpairReader } from "../card-device";
import { setStoreTaxRateBps } from "@floor/cloud";

export function SettingsScreen() {
  const { settings, saveSettings, isAdmin, session, taxRateBps, refreshTax } = usePos();
  const [paperKind, setPaperKind] = useState<PaperKind>(settings.paperKind);
  const [chars, setChars] = useState(settings.charsPerLine?.toString() ?? "");
  const [printerPath, setPrinterPath] = useState(settings.printerPath);
  const [reviewUrl, setReviewUrl] = useState(settings.reviewUrl);
  const [receiptLegal, setReceiptLegal] = useState(settings.receiptLegal || DEFAULT_LEGAL);
  const [terminalDeviceId, setTerminalDeviceId] = useState(settings.terminalDeviceId);
  const [taxPct, setTaxPct] = useState(taxRateBps != null ? (taxRateBps / 100).toFixed(2) : "");
  const [pairCode, setPairCode] = useState("");
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function save() {
    setError("");
    await saveSettings({
      ...settings,
      paperKind,
      charsPerLine: chars.trim() ? Number(chars) : null,
      printerPath,
      reviewUrl,
      receiptLegal,
      terminalDeviceId,
    });
    const pct = Number(taxPct);
    if (Number.isFinite(pct) && pct >= 0) {
      const bps = Math.round(pct * 100);
      try {
        await setStoreTaxRateBps(bps);
        await refreshTax();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setMsg("Saved.");
  }

  async function pairPhone() {
    setError("");
    try {
      const id = await pairReader(pairCode);
      setMsg(`Paired phone reader ${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pairing failed. Open Payment device on the phone.");
    }
  }

  async function adminAction(action: "poweroff" | "reboot" | "setpin") {
    const known = await hasAdminPin();
    if (known) {
      const ok = await verifyAdminPin(pin);
      if (!ok) {
        setError("Wrong admin PIN.");
        return;
      }
    } else if (!isAdmin) {
      setError("An owner or manager must set the admin PIN first.");
      return;
    }
    if (action === "setpin") {
      await setAdminPin(pin);
      setMsg("Admin PIN saved on this register.");
      return;
    }
    const result = await kioskPower(action);
    setMsg(result.detail);
  }

  return (
    <section className="page grid">
      <h1>Settings</h1>
      <p className="muted">Signed in as {session.displayName}.</p>
      {error ? <p className="error">{error}</p> : null}
      {msg ? <p>{msg}</p> : null}
      <label>
        Sales tax rate (%)
        <input
          value={taxPct}
          onChange={(e) => setTaxPct(e.target.value)}
          placeholder="e.g. 7.25"
          disabled={!isAdmin}
        />
      </label>
      <p className="muted">Required before checkout. Stored in store_settings (tax added on top of prices).</p>
      <label>
        Paper
        <select value={paperKind} onChange={(e) => setPaperKind(e.target.value as PaperKind)}>
          <option value="letter">8.5×11 thermal page (default)</option>
          <option value="roll80">80 mm roll</option>
          <option value="roll58">58 mm roll</option>
        </select>
      </label>
      <label>
        Characters per line override
        <input value={chars} onChange={(e) => setChars(e.target.value)} placeholder="blank = default" />
      </label>
      <label>
        Printer (CUPS name or /dev/usb/lp0)
        <input value={printerPath} onChange={(e) => setPrinterPath(e.target.value)} disabled={!isAdmin} />
      </label>
      <label>
        Google review URL
        <input value={reviewUrl} onChange={(e) => setReviewUrl(e.target.value)} disabled={!isAdmin} />
      </label>
      <label>
        Receipt legal
        <textarea rows={6} value={receiptLegal} onChange={(e) => setReceiptLegal(e.target.value)} disabled={!isAdmin} />
      </label>
      <button type="button" className="primary" onClick={() => void save()}>
        Save
      </button>
      {isAdmin ? (
        <div className="card grid">
          <strong>Pair phone reader</strong>
          <p className="muted">Type the 6-digit code from Floor → Payment device.</p>
          <input value={pairCode} onChange={(e) => setPairCode(e.target.value.toUpperCase())} placeholder="ABC123" />
          <button type="button" onClick={() => void pairPhone()}>
            Pair
          </button>
          <button type="button" onClick={() => void unpairReader().then(() => setMsg("Unpaired."))}>
            Unpair
          </button>
        </div>
      ) : null}
      {isAdmin ? (
        <div className="card grid">
          <strong>Square Terminal (later)</strong>
          <input value={terminalDeviceId} onChange={(e) => setTerminalDeviceId(e.target.value)} />
          <button
            type="button"
            onClick={() =>
              void callFunction("square-device-code", { method: "POST", body: JSON.stringify({ name: "Floor iMac" }) })
            }
          >
            Get Terminal pairing code
          </button>
        </div>
      ) : null}
      <div className="card grid">
        <strong>Admin PIN</strong>
        <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="PIN" />
        <button type="button" onClick={() => void adminAction("setpin")}>
          Set PIN
        </button>
        <button type="button" className="danger" onClick={() => void adminAction("poweroff")}>
          Shut down
        </button>
        <button type="button" onClick={() => void adminAction("reboot")}>
          Reboot
        </button>
      </div>
    </section>
  );
}
