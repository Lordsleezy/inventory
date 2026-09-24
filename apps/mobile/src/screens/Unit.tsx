import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { buildReceipt, centsToInput, formatCents, listedChannelsBySku, listedEbayItem, listingWeightLb, loadUnit, parseListingSpecs, parseMoneyToCents, specInchesValue, receiptHtml, saleForSku, unitHistory, type EditableField, type FloorEvent, type Sale, type Unit, type UnitState } from "@floor/store";
import { finalizeSale, floorCloud } from "@floor/cloud";
import { Photos } from "../components/Photos";
import { DangerButton, Label, MoneyField, Notice, SelectField, Spinner, TextField } from "../components/ui";
import { openHtml } from "../files";
import { useStore } from "../store";
import { applyChannelListing } from "../functions";
import { openExternalUrl } from "../oauth-browser";
import { askManagerPin } from "../pin";
import { ebayItemViewUrl } from "@floor/channels";
import { friendlyRpc, needsManagerPin, needsVoidFirst } from "../rpc";
import { ChannelMarks, ChannelToggleRow } from "../listingMarks";
import { showAdminUi } from "../flavor";

export function UnitScreen() {
  const { sku = "" } = useParams();
  const navigate = useNavigate();
  const { db, settings, online, session, hydrate, ensureOnline, cacheEpoch } = useStore();
  const admin = showAdminUi(session.role);

  const [unit, setUnit] = useState<Unit | null | undefined>(undefined);
  const [sale, setSale] = useState<Sale | null>(null);
  const [history, setHistory] = useState<FloorEvent[]>([]);
  const [error, setError] = useState("");
  const [askVoidForDelete, setAskVoidForDelete] = useState(false);

  const refresh = useCallback(async () => {
    const [found, currentSale, rows] = await Promise.all([
      loadUnit(db, sku),
      saleForSku(db, sku),
      unitHistory(db, sku),
    ]);
    setUnit(found);
    setSale(currentSale);
    setHistory(rows);
  }, [db, sku]);

  useEffect(() => {
    void refresh().catch((err) => setError(friendlyRpc(err)));
  }, [refresh, cacheEpoch]);

  async function edit(field: EditableField, value: string | number | null) {
    setError("");
    try {
      await ensureOnline();
      const { error: rpcErr } = await floorCloud().rpc("update_unit_field", {
        p_sku: sku,
        p_field: field,
        p_value: value == null ? "" : String(value),
      });
      if (rpcErr) throw rpcErr;
      await hydrate();
      await refresh();
    } catch (err) {
      setError(friendlyRpc(err));
      await refresh();
    }
  }

  async function editSpec(key: string, value: string) {
    const specs: Record<string, unknown> = { ...(parseListingSpecs(unit?.listingSpecs) || {}) };
    if (value.trim()) specs[key] = value.trim();
    else delete specs[key];
    await edit("listing_specs", JSON.stringify(specs));
  }

  async function move(state: UnitState) {
    setError("");
    try {
      await ensureOnline();
      const { error: rpcErr } = await floorCloud().rpc("set_unit_state", { p_sku: sku, p_state: state });
      if (rpcErr) throw rpcErr;
      await hydrate();
      await refresh();
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  async function undoSale(reason: string, thenDelete = false): Promise<boolean> {
    if (!reason.trim()) {
      setError("Enter a reason to void.");
      return false;
    }
    if (!sale || sale.voidedAt) {
      setError("No live sale to void.");
      return false;
    }
    setError("");
    try {
      await ensureOnline();
      const run = async (approvalId: string | null) => {
        const { error: rpcErr } = await floorCloud().rpc("void_sale", {
          p_sale_id: sale.id,
          p_reason: reason,
          p_approval_id: approvalId,
        });
        if (rpcErr) throw rpcErr;
      };
      try {
        await run(null);
      } catch (err) {
        if (!needsManagerPin(err)) throw err;
        const approvalId = await askManagerPin("void_sale", sku);
        await run(approvalId);
      }
      await hydrate();
      await refresh();
      if (thenDelete) await remove(true);
      return true;
    } catch (err) {
      setError(friendlyRpc(err));
      return false;
    }
  }

  async function printReceipt() {
    if (!sale || !unit) return;
    const receipt = buildReceipt(sale, unit, settings);
    await openHtml(`receipt-${receipt.receiptNo}.html`, receiptHtml(receipt));
  }

  async function remove(afterVoid = false) {
    setError("");
    if (!afterVoid && sale && !sale.voidedAt) {
      setError("This item has a sale. Void the sale first to delete it.");
      setAskVoidForDelete(true);
      return;
    }
    try {
      await ensureOnline();
      const run = async (approvalId: string | null) => {
        const { error: rpcErr } = await floorCloud().rpc("delete_unit", {
          p_sku: sku,
          p_approval_id: approvalId,
        });
        if (rpcErr) throw rpcErr;
      };
      try {
        await run(null);
      } catch (err) {
        if (needsVoidFirst(err) && !afterVoid) {
          setError("This item has a sale. Void the sale first to delete it.");
          setAskVoidForDelete(true);
          return;
        }
        if (!needsManagerPin(err)) throw err;
        const approvalId = await askManagerPin("delete_unit", sku);
        await run(approvalId);
      }
      setAskVoidForDelete(false);
      try {
        await hydrate();
      } catch {
        // Deletion already succeeded in the cloud.
      }
      navigate("/inventory", { replace: true });
    } catch (err) {
      if (needsVoidFirst(err) && !afterVoid) {
        setError("This item has a sale. Void the sale first to delete it.");
        setAskVoidForDelete(true);
        return;
      }
      setError(friendlyRpc(err));
      await refresh();
    }
  }

  if (unit === undefined) return <Spinner label="Reading" />;

  if (unit === null) {
    return (
      <section>
        <p className="text-body">No unit with SKU {sku}.</p>
        <p className="mt-2 text-quiet text-floor-mute">
          If it was deleted, the number stays spent and its history is still in the record.
        </p>
        <Link to="/inventory" className="btn-text px-0">
          Back to inventory
        </Link>
      </section>
    );
  }

  const sold = unit.state === "sold";

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-mono text-title">{unit.sku}</h1>
        <span className="text-quiet text-floor-mute">{unit.state}</span>
      </div>

      <Notice tone="error">{error}</Notice>

      {sold && sale ? (
        <div className="mt-2 border border-floor-line p-3">
          <p className="text-body">
            Sold for {formatCents(sale.priceCents)} on {sale.channel}
          </p>
          <p className="text-quiet text-floor-mute">
            {new Date(sale.soldAt).toLocaleString("en-US")} · {sale.receiptNo}
            {sale.customerName ? ` · ${sale.customerName}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <button type="button" className="btn-text px-0" onClick={() => void printReceipt()}>
              Receipt
            </button>
            <VoidSale onVoid={undoSale} />
          </div>
        </div>
      ) : null}

      <Photos sku={unit.sku} />

      <TextField label="Name" value={unit.title} onCommit={(v) => edit("title", v ?? "")} />
      <TextField label="Brand" value={unit.brand} onCommit={(v) => edit("brand", v ?? "")} />
      <TextField label="Model" value={unit.model} onCommit={(v) => edit("model", v ?? "")} />
      <div className="grid grid-cols-3 gap-x-4">
        <TextField
          label="Width (in)"
          value={specInchesValue(parseListingSpecs(unit.listingSpecs)?.width_in)}
          inputMode="decimal"
          onCommit={(v) => editSpec("width_in", v ?? "")}
        />
        <TextField
          label="Height (in)"
          value={specInchesValue(parseListingSpecs(unit.listingSpecs)?.height_in)}
          inputMode="decimal"
          onCommit={(v) => editSpec("height_in", v ?? "")}
        />
        <TextField
          label="Depth (in)"
          value={specInchesValue(parseListingSpecs(unit.listingSpecs)?.depth_in)}
          inputMode="decimal"
          onCommit={(v) => editSpec("depth_in", v ?? "")}
        />
      </div>
      <TextField
        label="Weight (lb)"
        value={specInchesValue(parseListingSpecs(unit.listingSpecs)?.weight_lb)}
        inputMode="decimal"
        onCommit={(v) => editSpec("weight_lb", v ?? "")}
      />
      <label className="flex items-center gap-2 border-b border-floor-line py-3">
        <input
          type="checkbox"
          checked={unit.shippable}
          onChange={(e) => void edit("shippable", e.target.checked ? "true" : "false")}
        />
        <span className="text-body">Shippable</span>
      </label>
      {unit.shippable && listingWeightLb(unit.listingSpecs) == null ? (
        <p className="text-quiet text-floor-accent">
          No Buy button on the website until this unit has a weight. Over 30 lb is not shippable.
        </p>
      ) : null}
      {unit.shippable ? (
        <MoneyField
          label="Shipping override (blank uses weight tiers: $20 / $32 / $50)"
          cents={unit.shippingCents}
          onCommit={(v) => edit("shipping_cents", v)}
        />
      ) : null}
      {admin ? <EbayFacebook sku={unit.sku} online={online} /> : null}
      <TextField
        label="Description"
        value={unit.listingBody ?? ""}
        multiline
        onCommit={(v) => edit("listing_body", v ?? "")}
      />

      <SelectField
        label="Category"
        value={unit.category}
        options={settings.categories}
        onCommit={(v) => edit("category", v)}
      />
      <SelectField
        label="Condition"
        value={unit.condition}
        options={settings.conditions}
        onCommit={(v) => edit("condition", v)}
      />
      <SelectField
        label="Test status"
        value={unit.testStatus}
        options={settings.testStatuses}
        onCommit={(v) => edit("test_status", v)}
      />
      <TextField label="Defects" value={unit.defectNotes} multiline onCommit={(v) => edit("defect_notes", v)} />

      <div className="grid grid-cols-2 gap-x-4">
        {admin ? (
          <MoneyField label="Cost" cents={unit.acquisitionCostCents} onCommit={(v) => edit("acquisition_cost_cents", v)} />
        ) : null}
        <MoneyField label="Asking price" cents={unit.askCents} onCommit={(v) => edit("ask_cents", v)} />
      </div>

      <History rows={history} />

      <div className="mt-6">
        {!sold && online ? (
          <SoldButton
            sku={sku}
            askCents={unit.askCents}
            channels={settings.channels}
            onSold={async () => {
              await hydrate();
              await refresh();
            }}
          />
        ) : null}

        {admin && !sold && unit.state !== "voided" ? (
          <DangerButton
            idle="Void this unit"
            confirm="Void it"
            onConfirm={() => move("voided")}
            onError={(err) => setError(friendlyRpc(err))}
          />
        ) : null}

        {admin && sold && sale && !sale.voidedAt ? (
          <div className="mt-4 border border-floor-line p-3">
            <p className="text-body">This item has a sale. Void the sale first to delete it.</p>
            <p className="mt-1 text-quiet text-floor-mute">
              {askVoidForDelete
                ? "Void the sale, then this item will be deleted. The receipt stays in Reports, marked VOID."
                : "The receipt stays in Reports, marked VOID. After voiding you can delete this item."}
            </p>
            <div className="mt-3">
              <VoidSale onVoid={(reason) => undoSale(reason, askVoidForDelete)} />
            </div>
          </div>
        ) : null}

        {admin ? (
          <div className="mt-4">
            {sold && sale && !sale.voidedAt ? (
              <button
                type="button"
                className="btn-text px-0 text-floor-danger"
                onClick={() => {
                  setError("This item has a sale. Void the sale first to delete it.");
                  setAskVoidForDelete(true);
                }}
              >
                Delete permanently
              </button>
            ) : (
              <DangerButton
                idle="Delete permanently"
                confirm="Delete forever"
                onConfirm={() => remove()}
                onError={(err) => setError(friendlyRpc(err))}
              />
            )}
          </div>
        ) : null}
      </div>
      {admin ? (
        <p className="mt-2 text-quiet text-floor-mute">
          Deleting removes the record. SKU {unit.sku} is never issued again, and its history stays.
        </p>
      ) : null}
    </section>
  );
}

function SoldButton({
  sku,
  askCents,
  channels,
  onSold,
}: {
  sku: string;
  askCents: number | null;
  channels: string[];
  onSold: () => Promise<void>;
}) {
  const { ensureOnline } = useStore();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState("facebook");
  const [price, setPrice] = useState(centsToInput(askCents));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!open) {
    return (
      <button type="button" className="btn-accent mb-4" onClick={() => setOpen(true)}>
        Sold
      </button>
    );
  }

  return (
    <div className="mb-4 border border-floor-line p-3">
      <p className="text-body">Where did it sell, and for how much?</p>
      <p className="mt-1 text-quiet text-floor-mute">
        Use this when the card reader is down or it sold on Facebook. Website and register sales record themselves.
      </p>
      <Notice tone="error">{error}</Notice>
      <label className="mt-2 block">
        <Label>Channel</Label>
        <select className="field mt-1" value={channel} onChange={(e) => setChannel(e.target.value)}>
          {channels.filter((c) => c !== "website").map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-2 block">
        <Label>Price</Label>
        <input className="field mt-1" value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} />
      </label>
      <div className="mt-3 flex gap-3">
        <button
          type="button"
          className="btn-accent"
          disabled={busy}
          onClick={() => {
            const cents = parseMoneyToCents(price);
            if (cents == null) {
              setError("Enter the price.");
              return;
            }
            setBusy(true);
            void (async () => {
              await ensureOnline();
              await finalizeSale({
                sku,
                channel,
                priceCents: cents,
                paymentMethod: "external",
                taxCents: 0,
              });
              try {
                const { authHeader, functionsUrl } = await import("../functions");
                const headers = await authHeader();
                await fetch(functionsUrl("ebay-withdraw"), {
                  method: "POST",
                  headers: { ...headers, "Content-Type": "application/json" },
                  body: JSON.stringify({ afterSale: true, sku }),
                });
              } catch {
                /* ebay-sync */
              }
              await onSold();
              setOpen(false);
            })()
              .catch((err) => setError(friendlyRpc(err)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Saving…" : "Record sale"}
        </button>
        <button type="button" className="btn-text px-0" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function EbayFacebook({ sku, online }: { sku: string; online: boolean }) {
  const { db, hydrate, ensureOnline, cacheEpoch } = useStore();
  const [listed, setListed] = useState<string[]>([]);
  const [ebayUrl, setEbayUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([listedChannelsBySku(db, [sku]), listedEbayItem(db, sku)])
      .then(([map, ebay]) => {
        setListed(map.get(sku) ?? []);
        setEbayUrl(ebay ? ebayItemViewUrl(ebay.listingId, import.meta.env.VITE_EBAY_ENV) : null);
      })
      .catch((err) => setError(friendlyRpc(err)));
  }, [db, sku, cacheEpoch]);

  async function toggle(channel: string, next: boolean) {
    setError("");
    try {
      await ensureOnline();
      await applyChannelListing(channel, [sku], next);
      await hydrate();
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  return (
    <div className="border-b border-floor-line py-3">
      <Label>Listings</Label>
      <p className="mt-1 text-quiet text-floor-mute">
        List on eBay uses the connected sandbox SDK. Listed on Facebook is a manual tick after you post it.
      </p>
      {listed.length ? (
        <div className="mt-2">
          <ChannelMarks channels={listed} />
        </div>
      ) : (
        <p className="mt-2 text-quiet text-floor-mute">Not listed anywhere.</p>
      )}
      <ChannelToggleRow
        options={["ebay", "facebook"]}
        listed={listed}
        disabled={!online}
        onToggle={(channel, next) => void toggle(channel, next)}
      />
      {ebayUrl ? (
        <button
          type="button"
          className="btn-text mt-2 px-0"
          onClick={() => void openExternalUrl(ebayUrl)}
        >
          View on eBay
        </button>
      ) : null}
      <Notice tone="error">{error}</Notice>
    </div>
  );
}

function VoidSale({ onVoid }: { onVoid: (reason: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  if (!open) {
    return (
      <button type="button" className="btn-text px-0 text-floor-danger" onClick={() => setOpen(true)}>
        Void sale
      </button>
    );
  }

  return (
    <span className="flex w-full flex-col gap-2">
      {localError ? <Notice tone="error">{localError}</Notice> : null}
      <span className="flex w-full flex-wrap items-center gap-2">
        <input
          className="field flex-1"
          value={reason}
          placeholder="Reason for the void"
          autoFocus
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          type="button"
          className="min-h-touch bg-floor-danger px-3 text-body font-medium text-black"
          disabled={busy}
          onClick={() => {
            if (!reason.trim()) {
              setLocalError("Enter a reason to void.");
              return;
            }
            setLocalError("");
            setBusy(true);
            void onVoid(reason)
              .then((ok) => {
                if (ok) setOpen(false);
              })
              .catch((err) => setLocalError(friendlyRpc(err)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Working…" : "Void"}
        </button>
        <button type="button" className="btn-text px-0" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </span>
    </span>
  );
}

function describe(row: FloorEvent): string {
  const money = /cost|MSRP|ask|floor/.test(row.field ?? "");
  const show = (value: string | null) => {
    if (value === null || value === "") return "blank";
    return money ? formatCents(Number(value)) : value;
  };

  if (row.kind === "sku_reused") return `SKU reused${row.note ? ` · ${row.note}` : ""}`;
  if (row.kind === "sold") return `Sold for ${formatCents(Number(row.newValue))}${row.note ? ` · ${row.note}` : ""}`;
  if (row.kind === "sale_void") return `Sale ${row.oldValue} voided · ${row.note ?? ""}`;
  if (row.kind === "deleted") return `Deleted${row.oldValue ? ` · ${row.oldValue}` : ""}`;
  if (row.kind === "photo") return "Photo added";
  if (row.kind === "photo_removed") return "Photo removed";
  if (row.kind === "manufacturer_photo_removed") return "Manufacturer photo removed";
  if (row.kind === "state") return `State ${row.oldValue} → ${row.newValue}${row.note ? ` · ${row.note}` : ""}`;
  return `${row.field ?? "Changed"} ${show(row.oldValue)} → ${show(row.newValue)}`;
}

function History({ rows }: { rows: FloorEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;
  const visible = expanded ? rows : rows.slice(0, 6);

  return (
    <div className="mt-5">
      <Label>History</Label>
      <ul className="mt-2">
        {visible.map((row) => (
          <li key={row.id} className="flex gap-3 py-1 text-quiet">
            <span className="w-28 shrink-0 text-floor-mute">
              {new Date(row.at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
            <span className="min-w-0 flex-1">{describe(row)}</span>
          </li>
        ))}
      </ul>
      {rows.length > 6 ? (
        <button type="button" className="btn-text px-0" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}
