import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  buildReceipt,
  formatCents,
  loadUnit,
  receiptHtml,
  saleForSku,
  unitHistory,
  type EditableField,
  type FloorEvent,
  type Sale,
  type Unit,
  type UnitState,
} from "@floor/store";
import { floorCloud } from "@floor/cloud";
import { Photos } from "../components/Photos";
import { DangerButton, Label, MoneyField, Notice, SelectField, Spinner, TextField } from "../components/ui";
import { openHtml } from "../files";
import { useStore } from "../store";
import { askManagerPin } from "../pin";
import { friendlyRpc, needsManagerPin } from "../rpc";

const MOVABLE_STATES: UnitState[] = ["available", "reserved", "repair", "scrapped", "lost"];

export function UnitScreen() {
  const { sku = "" } = useParams();
  const navigate = useNavigate();
  const { db, settings, online, session, hydrate, ensureOnline, cacheEpoch } = useStore();
  const manager = session.role !== "staff";

  const [unit, setUnit] = useState<Unit | null | undefined>(undefined);
  const [sale, setSale] = useState<Sale | null>(null);
  const [history, setHistory] = useState<FloorEvent[]>([]);
  const [error, setError] = useState("");

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
    void refresh().catch((err) => setError(err.message));
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
      setError(err instanceof Error ? err.message : String(err));
      await refresh();
    }
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
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function undoSale(reason: string) {
    if (!sale) return;
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
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  async function printReceipt() {
    if (!sale || !unit) return;
    const receipt = buildReceipt(sale, unit, settings);
    await openHtml(`receipt-${receipt.receiptNo}.html`, receiptHtml(receipt));
  }

  async function remove() {
    setError("");
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
        if (!needsManagerPin(err)) throw err;
        const approvalId = await askManagerPin("delete_unit", sku);
        await run(approvalId);
      }
      try {
        await hydrate();
      } catch {
        // Deletion already succeeded in the cloud.
      }
      navigate("/inventory", { replace: true });
    } catch (err) {
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
      ) : online ? (
        <Link to={`/checkout/${unit.sku}`} className="btn-accent mt-3 inline-block">
          Sell
        </Link>
      ) : (
        <p className="mt-3 text-quiet text-floor-danger">Connect to the internet to sell.</p>
      )}

      <Photos sku={unit.sku} />

      <TextField label="Brand" value={unit.brand} onCommit={(v) => edit("brand", v ?? "")} />
      <TextField label="Model" value={unit.model} onCommit={(v) => edit("model", v ?? "")} />
      <TextField label="Description" value={unit.title} onCommit={(v) => edit("title", v ?? "")} />

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
      <SelectField
        label="Location"
        value={unit.location}
        options={settings.locations}
        onCommit={(v) => edit("location", v)}
      />

      <div className="grid grid-cols-2 gap-x-4">
        {manager ? (
          <MoneyField label="Cost" cents={unit.acquisitionCostCents} onCommit={(v) => edit("acquisition_cost_cents", v)} />
        ) : null}
        <MoneyField label="MSRP" cents={unit.msrpCents} onCommit={(v) => edit("msrp_cents", v)} />
        <MoneyField label="Ask" cents={unit.askCents} onCommit={(v) => edit("ask_cents", v)} />
        {manager ? (
          <MoneyField label="Floor" cents={unit.floorCents} onCommit={(v) => edit("floor_cents", v)} />
        ) : null}
      </div>
      <MarkListed sku={unit.sku} channels={settings.channels} online={online} />

      <TextField label="Manufacturer serial" value={unit.mfrSerial} onCommit={(v) => edit("mfr_serial", v)} />
      <TextField label="UPC" value={unit.upc} onCommit={(v) => edit("upc", v)} inputMode="numeric" />
      <TextField label="Lot" value={unit.lot} onCommit={(v) => edit("lot", v)} />
      <TextField label="Defects and notes" value={unit.defectNotes} multiline onCommit={(v) => edit("defect_notes", v)} />

      {!sold ? (
        <div className="border-b border-floor-line py-3">
          <Label>Move to</Label>
          <div className="mt-2 flex flex-wrap gap-3">
            {MOVABLE_STATES.filter((state) => state !== unit.state).map((state) => (
              <button key={state} type="button" className="btn-text px-0" onClick={() => void move(state)}>
                {state}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <History rows={history} />

      <div className="mt-6 flex flex-wrap items-center gap-6">
        {!sold && unit.state !== "voided" ? (
          <DangerButton idle="Void this unit" confirm="Void it" onConfirm={() => move("voided")} />
        ) : null}
        <DangerButton
          idle="Delete permanently"
          confirm="Delete forever"
          onConfirm={remove}
          disabled={sold}
        />
      </div>
      <p className="mt-2 text-quiet text-floor-mute">
        Deleting removes the record. SKU {unit.sku} is never issued again, and its history stays.
      </p>
    </section>
  );
}

function MarkListed({ sku, channels, online }: { sku: string; channels: string[]; online: boolean }) {
  const [channel, setChannel] = useState(channels.find((c) => c !== "floor") ?? "ebay");
  const [msg, setMsg] = useState("");
  async function mark() {
    setMsg("");
    const { error } = await floorCloud().rpc("mark_listed", { p_sku: sku, p_channel: channel, p_listing_id: null });
    setMsg(error ? error.message : `Listed on ${channel}`);
  }
  return (
    <div className="border-b border-floor-line py-3">
      <Label>Mark as listed on</Label>
      <div className="mt-2 flex items-center gap-2">
        <select className="field" value={channel} onChange={(e) => setChannel(e.target.value)}>
          {channels.filter((c) => c !== "floor").map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <button type="button" className="btn-text px-0" disabled={!online} onClick={() => void mark()}>
          Save
        </button>
      </div>
      {msg ? <p className="text-quiet mt-1">{msg}</p> : null}
    </div>
  );
}

function VoidSale({ onVoid }: { onVoid: (reason: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <button type="button" className="btn-text px-0 text-floor-danger" onClick={() => setOpen(true)}>
        Void sale
      </button>
    );
  }

  return (
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
        disabled={!reason.trim()}
        onClick={() => void onVoid(reason).then(() => setOpen(false))}
      >
        Void
      </button>
      <button type="button" className="btn-text px-0" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}

function describe(row: FloorEvent): string {
  const money = /cost|MSRP|ask|floor/.test(row.field ?? "");
  const show = (value: string | null) => {
    if (value === null || value === "") return "blank";
    return money ? formatCents(Number(value)) : value;
  };

  if (row.kind === "received") return `Received${row.note ? ` · ${row.note}` : ""}`;
  if (row.kind === "sold") return `Sold for ${formatCents(Number(row.newValue))}${row.note ? ` · ${row.note}` : ""}`;
  if (row.kind === "sale_void") return `Sale ${row.oldValue} voided · ${row.note ?? ""}`;
  if (row.kind === "deleted") return `Deleted${row.oldValue ? ` · ${row.oldValue}` : ""}`;
  if (row.kind === "photo") return "Photo added";
  if (row.kind === "photo_removed") return "Photo removed";
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
