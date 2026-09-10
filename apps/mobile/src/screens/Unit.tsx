import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  buildReceipt,
  deleteUnit,
  formatCents,
  loadUnit,
  receiptHtml,
  saleForSku,
  setUnitState,
  unitHistory,
  updateUnit,
  type EditableField,
  type FloorEvent,
  type Sale,
  type Unit,
  type UnitState,
  voidSale,
} from "@floor/store";
import { MarkSold } from "../components/MarkSold";
import { Photos } from "../components/Photos";
import { DangerButton, Label, MoneyField, Notice, SelectField, Spinner, TextField } from "../components/ui";
import { openHtml } from "../files";
import { useStore } from "../store";

const MOVABLE_STATES: UnitState[] = ["available", "reserved", "repair", "scrapped", "lost"];

export function UnitScreen() {
  const { sku = "" } = useParams();
  const navigate = useNavigate();
  const { db, settings } = useStore();

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
  }, [refresh]);

  async function edit(field: EditableField, value: string | number | null) {
    setError("");
    try {
      await updateUnit(db, sku, { [field]: value });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refresh();
    }
  }

  async function move(state: UnitState) {
    setError("");
    try {
      await setUnitState(db, sku, state);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function undoSale(reason: string) {
    if (!sale) return;
    setError("");
    try {
      await voidSale(db, sale.id, reason);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      await deleteUnit(db, sku);
      navigate("/inventory", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      ) : (
        <MarkSold unit={unit} onSold={refresh} />
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
        <MoneyField label="Cost" cents={unit.acquisitionCostCents} onCommit={(v) => edit("acquisition_cost_cents", v)} />
        <MoneyField label="MSRP" cents={unit.msrpCents} onCommit={(v) => edit("msrp_cents", v)} />
        <MoneyField label="Ask" cents={unit.askCents} onCommit={(v) => edit("ask_cents", v)} />
        <MoneyField label="Floor" cents={unit.floorCents} onCommit={(v) => edit("floor_cents", v)} />
      </div>

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
