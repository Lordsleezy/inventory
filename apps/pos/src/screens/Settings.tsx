import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { setStoreSetting, setStoreTaxRateBps, floorCloud } from "@floor/cloud";
import { usePos } from "../pos-context";
import { callFunction } from "../functions";
import {
  hasAdminPin,
  kioskPower,
  listPrinters,
  printerPaperHint,
  setAdminPin,
  verifyAdminPin,
  type PrinterInfo,
} from "../local";
import { printReceipt } from "../print-receipt";
import { DEFAULT_LEGAL, type PaperKind } from "../receipt";
import { pairReader, unpairReader } from "../card-device";

export function SettingsScreen() {
  const { settings, saveSettings, isAdmin, session, taxRateBps, refreshTax, refreshRewards, rewards } =
    usePos();
  const [paperKind, setPaperKind] = useState<PaperKind>(settings.paperKind);
  const [chars, setChars] = useState(settings.charsPerLine?.toString() ?? "");
  const [printerPath, setPrinterPath] = useState(settings.printerPath);
  const [reviewUrl, setReviewUrl] = useState(settings.reviewUrl);
  const [receiptLegal, setReceiptLegal] = useState(settings.receiptLegal || DEFAULT_LEGAL);
  const [terminalDeviceId, setTerminalDeviceId] = useState(settings.terminalDeviceId);
  const [taxPct, setTaxPct] = useState(taxRateBps != null ? (taxRateBps / 100).toFixed(2) : "");
  const [cardFeePct, setCardFeePct] = useState((rewards.cardFeeBps / 100).toFixed(2));
  const [maxDiscPct, setMaxDiscPct] = useState((rewards.clerkMaxDiscountBps / 100).toFixed(0));
  const [pointsPerDollar, setPointsPerDollar] = useState(String(rewards.rewardsPointsPerDollar));
  const [pointValueCents, setPointValueCents] = useState(String(rewards.rewardsPointValueCents));
  const [pairCode, setPairCode] = useState("");
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printerDefault, setPrinterDefault] = useState<string | null>(null);
  const [printBusy, setPrintBusy] = useState(false);
  const [squareStatus, setSquareStatus] = useState<{
    connected: boolean;
    location_id?: string | null;
    location_name?: string | null;
    sandbox?: boolean;
  } | null>(null);
  const [locations, setLocations] = useState<{ id: string; name?: string }[]>([]);

  async function refreshSquare() {
    const { data } = await floorCloud().rpc("my_square_connection_status");
    setSquareStatus((data as typeof squareStatus) ?? { connected: false });
  }

  useEffect(() => {
    if (!isAdmin) return;
    void refreshSquare().catch(() => setSquareStatus({ connected: false }));
  }, [isAdmin]);

  useEffect(() => {
    setMaxDiscPct((rewards.clerkMaxDiscountBps / 100).toFixed(0));
    setPointsPerDollar(String(rewards.rewardsPointsPerDollar));
    setPointValueCents(String(rewards.rewardsPointValueCents));
    setCardFeePct((rewards.cardFeeBps / 100).toFixed(2));
  }, [rewards]);

  useEffect(() => {
    void listPrinters()
      .then((res) => {
        setPrinters(res.printers);
        setPrinterDefault(res.default);
      })
      .catch(() => setPrinters([]));
  }, []);

  async function pickPrinter(name: string) {
    setPrinterPath(name);
    if (name) {
      const hint = await printerPaperHint(name);
      setPaperKind(hint);
      setMsg(`Printer ${name}: paper layout auto-set to ${hint === "letter" ? "full page" : hint}.`);
    }
  }

  async function testPrint() {
    setPrintBusy(true);
    setError("");
    setMsg("");
    try {
      const result = await printReceipt(
        {
          receiptNo: "TEST",
          soldAt: new Date().toLocaleString(),
          clerkName: session.displayName,
          sku: "TEST-1",
          title: "Printer test — receipt layout check",
          condition: null,
          priceCents: 100,
          taxCents: 7,
          totalCents: 110,
          subtotalCents: 100,
          cardFeeCents: 3,
          tender: "CARD · Visa •••• 4242",
          tenderDetails: { method: "CARD", cardBrand: "Visa", cardLast4: "4242", cardCents: 110 },
          reviewUrl: reviewUrl || null,
          legal: receiptLegal,
        },
        { ...settings, paperKind, printerPath, reviewUrl, receiptLegal },
      );
      if (result.printed) setMsg(result.detail || "Test receipt sent to printer.");
      else setError(result.detail || "Test print failed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPrintBusy(false);
    }
  }

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
    try {
      const maxBps = Math.round(Number(maxDiscPct) * 100);
      if (Number.isFinite(maxBps) && maxBps >= 0) {
        await setStoreSetting("clerk_max_discount_bps", maxBps);
      }
      const ppd = Number(pointsPerDollar);
      if (Number.isFinite(ppd) && ppd >= 0) {
        await setStoreSetting("rewards_points_per_dollar", ppd);
      }
      const pvc = Number(pointValueCents);
      if (Number.isFinite(pvc) && pvc >= 0) {
        await setStoreSetting("rewards_point_value_cents", pvc);
      }
      const feePct = Number(cardFeePct);
      if (Number.isFinite(feePct) && feePct >= 0 && feePct <= 100) {
        await setStoreSetting("card_fee_bps", Math.round(feePct * 100));
      }
      await refreshRewards();
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} (rewards/discount settings need the register_ux migration)`
          : String(err),
      );
      return;
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

  async function connectSquare() {
    setError("");
    try {
      const res = await callFunction("square-connect-start", { method: "POST", body: "{}" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          `Connect Square failed (HTTP ${res.status}): ${body.error || body.message || "unknown"}. Is Netlify redeployed with SQUARE_* env vars?`,
        );
      }
      if (!body.url) throw new Error("Connect Square returned no authorize URL");
      window.open(body.url, "_blank", "noopener,noreferrer");
      setMsg("Complete Square authorize in the browser, then click Refresh status.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadLocations() {
    setError("");
    try {
      const res = await callFunction("square-list-locations", { method: "GET" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          `List locations failed (HTTP ${res.status}): ${body.error || body.message || "unknown"}`,
        );
      }
      setLocations(body.locations || []);
      setMsg(`Loaded ${(body.locations || []).length} Square location(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function pickLocation(id: string, name?: string) {
    setError("");
    try {
      const res = await callFunction("square-set-store-location", {
        method: "POST",
        body: JSON.stringify({ locationId: id, locationName: name || null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "set_location_failed");
      await refreshSquare();
      setMsg(`Square location set to ${name || id}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        Card fee (%)
        <input
          value={cardFeePct}
          onChange={(e) => setCardFeePct(e.target.value)}
          placeholder="e.g. 2.50"
          disabled={!isAdmin}
        />
      </label>
      <p className="muted">
        Charged on the card-paid portion only — never part of sales tax. 0 disables it.
      </p>

      <div className="card grid">
        <strong>Discounts & rewards</strong>
        <label>
          Max clerk discount (%)
          <input value={maxDiscPct} onChange={(e) => setMaxDiscPct(e.target.value)} disabled={!isAdmin} />
        </label>
        <label>
          Rewards earn rate (points per dollar)
          <input value={pointsPerDollar} onChange={(e) => setPointsPerDollar(e.target.value)} disabled={!isAdmin} />
        </label>
        <label>
          Point value (cents each)
          <input value={pointValueCents} onChange={(e) => setPointValueCents(e.target.value)} disabled={!isAdmin} />
        </label>
        <p className="muted">Default: 1 pt / $1 and 1¢ per point (100 pts = $1).</p>
      </div>

      <div className="card grid">
        <strong>Receipts</strong>
        <Link to="/settings/receipt">Open receipt designer →</Link>
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
          <select
            value={printers.some((p) => p.name === printerPath) ? printerPath : ""}
            onChange={(e) => void pickPrinter(e.target.value)}
            disabled={!isAdmin}
          >
            <option value="">{printerDefault ? `Default (${printerDefault})` : "— choose —"}</option>
            {printers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} ({p.status})
              </option>
            ))}
          </select>
        </label>
        <label>
          Printer override (raw queue/path)
          <input value={printerPath} onChange={(e) => setPrinterPath(e.target.value)} disabled={!isAdmin} />
        </label>
        <div className="row">
          <button type="button" disabled={printBusy} onClick={() => void testPrint()}>
            {printBusy ? "Printing…" : "Print test receipt"}
          </button>
        </div>
        <label>
          Google review URL
          <input value={reviewUrl} onChange={(e) => setReviewUrl(e.target.value)} disabled={!isAdmin} />
        </label>
        <label>
          Receipt legal
          <textarea rows={6} value={receiptLegal} onChange={(e) => setReceiptLegal(e.target.value)} disabled={!isAdmin} />
        </label>
      </div>

      <button type="button" className="primary" onClick={() => void save()}>
        Save
      </button>
      {isAdmin ? (
        <div className="card grid">
          <strong>Connect Square{squareStatus?.connected ? (squareStatus.sandbox ? " (sandbox)" : " (production)") : ""}</strong>
          <p className="muted">
            {squareStatus?.connected
              ? `Connected${squareStatus.sandbox ? " (sandbox)" : ""}${
                  squareStatus.location_name || squareStatus.location_id
                    ? ` · location ${squareStatus.location_name || squareStatus.location_id}`
                    : " · pick a location (required before phone can charge)"
                }`
              : "Not connected — tap Connect Square, finish authorize in the browser, then Refresh status and pick a location. Phone charges will fail until this shows Connected."}
          </p>
          <div className="row">
            <button type="button" onClick={() => void connectSquare()}>
              Connect Square
            </button>
            <button type="button" onClick={() => void refreshSquare().then(() => setMsg("Square status refreshed."))}>
              Refresh status
            </button>
            <button type="button" onClick={() => void loadLocations()}>
              List locations
            </button>
          </div>
          {locations.length ? (
            <ul>
              {locations.map((l) => (
                <li key={l.id}>
                  <button type="button" onClick={() => void pickLocation(l.id, l.name)}>
                    Use {l.name || l.id}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
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
