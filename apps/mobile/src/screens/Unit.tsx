import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  buildReceipt,
  formatCents,
  listedChannelsBySku,
  listedEbayItem,
  loadUnit,
  parseListingSpecs,
  receiptHtml,
  saleForSku,
  specInchesValue,
  type EditableField,
  type Sale,
  type Unit,
} from "@floor/store";
import { floorCloud } from "@floor/cloud";
import { ebayItemViewUrl } from "@floor/channels";
import { Photos } from "../components/Photos";
import { OnlineShipping } from "../components/OnlineShipping";
import { MarketplacePrices } from "../components/MarketplacePrices";
import { UnitCost } from "../components/UnitCost";
import { DangerButton, MoneyField, Notice, SelectField, Spinner, TextField } from "../components/ui";
import { openHtml } from "../files";
import { useStore } from "../store";
import { openExternalUrl } from "../oauth-browser";
import { applyChannelListing } from "../functions";
import { MarketplaceSaleButton } from "../components/MarketplaceSaleButton";
import { askManagerPin } from "../pin";
import { friendlyRpc, needsManagerPin, needsVoidFirst } from "../rpc";

export function UnitScreen() {
  const { sku = "" } = useParams();
  const navigate = useNavigate();
  const { db, settings, online, session, hydrate, ensureOnline, cacheEpoch } = useStore();
  const admin = session.role !== "staff";

  const [unit, setUnit] = useState<Unit | null | undefined>(undefined);
  const [sale, setSale] = useState<Sale | null>(null);
  const [error, setError] = useState("");
  const [askVoidForDelete, setAskVoidForDelete] = useState(false);
  const [listed, setListed] = useState<string[]>([]);
  const [ebayUrl, setEbayUrl] = useState<string | null>(null);
  const [ebayBusy, setEbayBusy] = useState(false);
  const [enriched, setEnriched] = useState<Record<string, any>>({});
  const [eligibility, setEligibility] = useState<{ channel: string; status: string; reason: string }[]>([]);

  const loadEnriched = useCallback(async () => {
    if (!online) return;
    const [{ data }, elig] = await Promise.all([
      floorCloud().from(admin ? 'units' : 'units_pos').select('*').eq('sku', sku).maybeSingle(),
      floorCloud().rpc('unit_marketplace_eligibility', { p_sku: sku }),
    ]);
    if (data) setEnriched(data as Record<string, any>);
    if (!elig.error && Array.isArray(elig.data)) {
      setEligibility(elig.data as { channel: string; status: string; reason: string }[]);
    }
  }, [admin, online, sku]);

  useEffect(() => {
    void loadEnriched();
    const timer = window.setInterval(() => void loadEnriched(), 5000);
    return () => window.clearInterval(timer);
  }, [loadEnriched, cacheEpoch]);

  async function editCloud(field: string, value: string | number | null) {
    setError('');
    try {
      await ensureOnline();
      const { error: err } = await floorCloud().rpc('update_unit_field', {
        p_sku: sku, p_field: field, p_value: value == null ? '' : String(value),
      });
      if (err) throw err;
      await hydrate(); await refresh(); await loadEnriched();
    } catch (err) { setError(friendlyRpc(err)); }
  }

  const refresh = useCallback(async () => {
    const [found, currentSale, map, ebay] = await Promise.all([
      loadUnit(db, sku),
      saleForSku(db, sku),
      listedChannelsBySku(db, [sku]),
      listedEbayItem(db, sku),
    ]);
    setUnit(found);
    setSale(currentSale);
    setListed(map.get(sku) ?? []);
    setEbayUrl(ebay ? ebayItemViewUrl(ebay.listingId, import.meta.env.VITE_EBAY_ENV) : null);
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


  async function setListOnline(next: boolean) {
    await edit("show_on_website", next ? "true" : "false");
  }

  async function saveDescription(value: string | null) { await edit("listing_body", value ?? ""); await loadEnriched(); }

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
        /* deletion already succeeded */
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

  async function listOnEbay() {
    setError("");
    setEbayBusy(true);
    try {
      await ensureOnline();
      await applyChannelListing("ebay", [sku], true);
      await hydrate();
      await refresh();
    } catch (err) {
      setError(friendlyRpc(err));
    } finally {
      setEbayBusy(false);
    }
  }

  async function setFacebook(next: boolean) {
    setError("");
    try {
      await ensureOnline();
      await applyChannelListing("facebook", [sku], next);
      await hydrate();
      await refresh();
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  if (unit === undefined) return <Spinner label="Reading" />;

  if (unit === null) {
    return (
      <section>
        <p className="text-body">No unit with SKU {sku}.</p>
        <Link to="/inventory" className="btn-text px-0">
          Back to inventory
        </Link>
      </section>
    );
  }

  const sold = unit.state === "sold";
  const facebookOn = listed.some((c) => /facebook|^fb$/i.test(c));
  const ebayOn = listed.some((c) => c.toLowerCase() === "ebay");
  const specs = parseListingSpecs(unit.listingSpecs);

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

      <div className="border-b border-floor-line py-3">
        <OnlineShipping sku={unit.sku} ensureOnline={ensureOnline} />
        <MarketplacePrices sku={unit.sku} />
        <label className="mt-3 flex items-center gap-2">
          <input
            type="checkbox"
            checked={unit.showOnWebsite}
            onChange={(e) => void setListOnline(e.target.checked)}
          />
          <span className="text-body">List online</span>
        </label>
        <p className="mt-1 text-quiet text-floor-mute">
          Puts this item on the website. Needs at least one photo.
        </p>
        {eligibility.length > 0 ? (
          <div className="mt-3 space-y-1">
            <p className="text-quiet">Marketplace eligibility</p>
            {eligibility.filter((row) => ['depop', 'ebay', 'whatnot', 'mercari', 'facebook', 'website'].includes(row.channel)).map((row) => (
              <p key={row.channel} className={`text-quiet ${row.status === 'allow' ? 'text-floor-mute' : 'text-floor-danger'}`}>
                {row.reason}
              </p>
            ))}
          </div>
        ) : null}
        {(enriched.requires_power != null || enriched.is_camera != null) ? (
          <p className="mt-2 text-quiet text-floor-mute">
            Power: {enriched.requires_power ? 'yes' : enriched.requires_power === false ? 'no' : 'unknown'}
            {enriched.is_camera ? ' · camera' : ''}
            {enriched.is_electrical ? ' · electrical' : ''}
          </p>
        ) : null}
      </div>

      <TextField label="Brand" value={unit.brand} onCommit={(v) => edit("brand", v ?? "")} />
      <TextField label="Model" value={unit.model} onCommit={(v) => edit("model", v ?? "")} />
      <TextField label="Title" value={unit.title} onCommit={(v) => edit("title", v ?? "")} />
      <MoneyField label="Value (highest retail)" cents={enriched.msrp_cents ?? unit.msrpCents}
        onCommit={(v) => edit("msrp_cents", v)} />
      {enriched.dims_source === 'estimated' && <p className="text-floor-danger">Estimated dimensions — check before shipping.</p>}
      <div className="grid grid-cols-2 gap-x-4">
        {([['product_height_in','Product height (in)'],['product_width_in','Product width (in)'],
          ['product_depth_in','Product depth (in)'],['product_weight_lb','Product weight (lb)'],
          ['package_length_in','Box length (in)'],['package_width_in','Box width (in)'],
          ['package_height_in','Box height (in)'],['package_weight_lb','Box weight (lb)']] as const)
          .map(([field,label]) => <TextField key={field}
            label={label + (String(enriched.listing_specs?.dims_sources?.[field]||'').startsWith('estimated')?' · estimated — check':'')}
            value={enriched[field] == null ? '' : String(enriched[field])} inputMode="decimal"
            onCommit={(v) => editCloud(field,v)} />)}
      </div>
      <div className="grid grid-cols-3 gap-x-4">
        <TextField
          label="Width (in)"
          value={specInchesValue(specs?.width_in)}
          inputMode="decimal"
          onCommit={(v) => editSpec("width_in", v ?? "")}
        />
        <TextField
          label="Height (in)"
          value={specInchesValue(specs?.height_in)}
          inputMode="decimal"
          onCommit={(v) => editSpec("height_in", v ?? "")}
        />
        <TextField
          label="Depth (in)"
          value={specInchesValue(specs?.depth_in)}
          inputMode="decimal"
          onCommit={(v) => editSpec("depth_in", v ?? "")}
        />
      </div>
      <TextField
        label="Weight (lb)"
        value={specInchesValue(specs?.weight_lb)}
        inputMode="decimal"
        onCommit={(v) => editSpec("weight_lb", v ?? "")}
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
      <TextField
        label="Description"
        value={enriched.listing_body || enriched.ai_description || unit.listingBody || ""}
        multiline
        onCommit={(v) => saveDescription(v)}
      />
      <TextField label="Defects" value={unit.defectNotes} multiline onCommit={(v) => edit("defect_notes", v)} />
      <MoneyField label="Price" cents={unit.askCents} onCommit={(v) => edit("ask_cents", v)} />
      <UnitCost sku={unit.sku} ensureOnline={ensureOnline} />
      <SelectField
        label="Category"
        value={unit.category}
        options={settings.categories}
        onCommit={(v) => edit("category", v)}
      />

      {admin ? (
        <div className="border-b border-floor-line py-3">
          <p className="text-quiet">eBay listing is disabled.</p>

          <label className="mt-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={facebookOn}
              disabled={!online}
              onChange={(e) => void setFacebook(e.target.checked)}
            />
            <span className="text-body">Listed on Facebook</span>
          </label>
        </div>
      ) : null}

      <div className="mt-6">
        {sold && sale && !sale.voidedAt ? (
          <div className="mb-4 border border-floor-line p-3">
            <p className="text-body">This item has a sale. Void the sale first to delete it.</p>
            {askVoidForDelete ? <VoidSale onVoid={(reason) => undoSale(reason, true)} /> : null}
          </div>
        ) : null}

        {sold && sale && !sale.voidedAt ? (
          <button
            type="button"
            className="btn-text px-0 text-floor-danger"
            onClick={() => {
              setError("This item has a sale. Void the sale first to delete it.");
              setAskVoidForDelete(true);
            }}
          >
            Delete
          </button>
        ) : (
          <DangerButton
            idle="Delete"
            confirm="Delete forever"
            onConfirm={() => remove()}
            onError={(err) => setError(friendlyRpc(err))}
          />
        )}

        {!sold && admin && <MarketplaceSaleButton sku={sku} askCents={unit.askCents} disabled={!online} onDone={async () => { await hydrate(); await refresh(); }} />}
        {!sold && online ? (
          <Link to={`/checkout/${unit.sku}`} className="btn-accent mt-4 block text-center">
            Sell
          </Link>
        ) : !sold ? (
          <p className="mt-4 text-quiet text-floor-danger">Connect to the internet to sell.</p>
        ) : null}
      </div>
    </section>
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
