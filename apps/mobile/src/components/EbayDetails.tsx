import { useEffect, useState } from "react";
import { fetchCategoryEbayAspects, fetchUnitEbayAspects, saveEbayAspect, type EbayAspectRow } from "../ebayAspects";
import { Label, Notice, SelectField, Spinner, TextField } from "./ui";
import { friendlyRpc } from "../rpc";

export function EbayDetails({
  sku,
  category,
  cacheKey,
}: {
  sku: string;
  category: string | null;
  cacheKey: string;
}) {
  const [rows, setRows] = useState<EbayAspectRow[] | null>(null);
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [unmapped, setUnmapped] = useState("");

  async function load(refresh = false) {
    setError("");
    setUnmapped("");
    try {
      const data = await fetchUnitEbayAspects(sku, refresh);
      setRows(data.aspects || []);
      setReady(Boolean(data.ready));
      setMissing(data.missing || []);
      setLabel(data.category ? `${data.category.name} · eBay ${data.category.ebayCategoryId}` : "");
    } catch (err) {
      const message = friendlyRpc(err);
      if (/not one of Floor|mapped to eBay/i.test(message)) {
        setUnmapped(message);
        setRows([]);
        setReady(false);
      } else {
        setError(message);
      }
    }
  }

  useEffect(() => {
    void load();
  }, [sku, category, cacheKey]);

  async function setAspect(name: string, value: string | null) {
    setError("");
    try {
      await saveEbayAspect({ sku, aspect: name, value: value || "", remember: true });
      await load();
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  return (
    <div className="border-b border-floor-line py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-body">eBay details</h2>
        {ready ? (
          <span className="text-quiet text-floor-ok">Ready to list</span>
        ) : rows ? (
          <span className="text-quiet text-floor-danger">Missing {missing.length || "fields"}</span>
        ) : null}
      </div>
      {label ? <p className="text-quiet text-floor-mute">{label}</p> : null}
      <Notice tone="error">{error || unmapped}</Notice>
      {unmapped ? (
        <p className="text-quiet text-floor-mute">
          Floor lists refrigerators, freezers, washers, dryers, ranges/ovens, dishwashers, microwaves,
          laptops, TVs, small kitchen appliances, tools, and vacuums. Ask before adding another eBay
          category.
        </p>
      ) : null}
      {rows === null ? <Spinner label="Loading eBay fields" /> : null}
      {missing.length ? (
        <p className="text-quiet text-floor-danger">Still needed: {missing.join(", ")}</p>
      ) : null}
      {rows?.map((row) => {
        const hint = row.source === "set" ? "set" : row.source === "remembered" ? "remembered" : row.source === "default" ? "default" : row.value ? "from unit" : "needed";
        const labelText = `${row.name}${row.required ? "" : row.recommended ? " (recommended)" : ""}${row.value ? ` · ${hint}` : ""}`;
        if (row.selectionOnly && (row.allowed || []).length) {
          return (
            <SelectField
              key={row.name}
              label={labelText}
              value={row.value || ""}
              options={row.allowed || []}
              onCommit={(v) => setAspect(row.name, v)}
            />
          );
        }
        return (
          <TextField
            key={row.name}
            label={labelText}
            value={row.value || ""}
            onCommit={(v) => setAspect(row.name, v)}
          />
        );
      })}
      <button type="button" className="btn-text px-0 py-2" onClick={() => void load(true)}>
        Refresh eBay fields
      </button>
    </div>
  );
}

export function EbayBulkEdit({
  skus,
  categoryHint,
}: {
  skus: string[];
  categoryHint: string;
}) {
  const [aspects, setAspects] = useState<EbayAspectRow[]>([]);
  const [aspect, setAspect] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    setOk("");
    if (!categoryHint || !skus.length) {
      setAspects([]);
      return;
    }
    void fetchCategoryEbayAspects(categoryHint)
      .then((data) => setAspects(data.aspects || []))
      .catch((err) => setError(friendlyRpc(err)));
  }, [categoryHint, skus.length]);

  const current = aspects.find((row) => row.name === aspect);
  const options = current?.allowed || [];

  async function apply() {
    setError("");
    setOk("");
    if (!aspect || !value) {
      setError("Pick an eBay field and a value.");
      return;
    }
    try {
      await saveEbayAspect({ skus, aspect, value, remember: true });
      setOk(`Set ${aspect} on ${skus.length} units and remembered it for this category.`);
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  if (!skus.length) return null;
  return (
    <div className="mt-2 border border-floor-line p-3">
      <Label>eBay field on selected</Label>
      {!categoryHint ? (
        <p className="text-quiet text-floor-mute">Select units in one mapped eBay category.</p>
      ) : (
        <>
          <select className="field mt-2" value={aspect} onChange={(e) => { setAspect(e.target.value); setValue(""); }} aria-label="eBay aspect">
            <option value="">Field</option>
            {aspects.map((row) => (
              <option key={row.name} value={row.name}>
                {row.name}
              </option>
            ))}
          </select>
          {options.length ? (
            <select className="field mt-2" value={value} onChange={(e) => setValue(e.target.value)} aria-label="eBay value">
              <option value="">Value</option>
              {options.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          ) : (
            <input className="field mt-2" value={value} placeholder="Value" onChange={(e) => setValue(e.target.value)} />
          )}
          <button type="button" className="btn-text mt-2 px-0" onClick={() => void apply()}>
            Apply to selected
          </button>
        </>
      )}
      <Notice tone="error">{error}</Notice>
      <Notice tone="ok">{ok}</Notice>
    </div>
  );
}
