import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { centsToInput, formatCents, parseMoneyToCents } from "@floor/store";
import { authErrorMessage, floorCloud, storagePathForPhoto } from "@floor/cloud";
import { usePos } from "../pos-context";

type UnitRow = Record<string, unknown>;

export function UnitDetailScreen() {
  const { sku = "" } = useParams();
  const { isAdmin, online, session } = usePos();
  const navigate = useNavigate();
  const [unit, setUnit] = useState<UnitRow | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<{ id: number; path: string; is_primary: boolean }[]>([]);

  async function load() {
    const sb = floorCloud();
    const table = isAdmin ? "units" : "units_pos";
    const { data, error: err } = await sb.from(table).select("*").eq("sku", sku).maybeSingle();
    if (err) setError(err.message);
    else setUnit(data);
    const { data: ph } = await sb.from("photos").select("id, path, is_primary").eq("sku", sku).order("is_primary", { ascending: false });
    setPhotos((ph as typeof photos) ?? []);
  }

  useEffect(() => {
    void load();
  }, [sku, isAdmin]);

  async function saveField(field: string, value: string | number | null) {
    if (!isAdmin) return;
    setBusy(true);
    setError("");
    try {
      const { error: rpcErr } = await floorCloud().rpc("update_unit_field", {
        p_sku: sku,
        p_field: field,
        p_value: value == null ? null : String(value),
      });
      if (rpcErr) throw rpcErr;
      setMsg("Saved.");
      await load();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length || !isAdmin) return;
    setBusy(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const path = storagePathForPhoto(session.storeId, sku, `${Date.now()}-${file.name}`);
        const { error: upErr } = await floorCloud().storage.from("unit-photos").upload(path, buf, {
          contentType: file.type || "image/jpeg",
          upsert: false,
        });
        if (upErr) throw upErr;
        const { error: rpcErr } = await floorCloud().rpc("add_unit_photo", { p_sku: sku, p_path: path });
        if (rpcErr) throw rpcErr;
        try {
          const { uploadWebDerivatives, WEB_CACHE_CONTROL } = await import("../web-photo");
          await uploadWebDerivatives(async (derivPath, bytes, contentType) => {
            const { error: dErr } = await floorCloud().storage.from("unit-photos").upload(derivPath, bytes, {
              contentType,
              upsert: true,
              cacheControl: WEB_CACHE_CONTROL,
            });
            if (dErr) throw dErr;
          }, path, buf);
        } catch {
          /* original still uploaded; website may regenerate later */
        }
      }
      setMsg("Photos uploaded.");
      await load();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!unit) {
    return (
      <section className="page">
        {error ? <p className="error">{error}</p> : <p>Loading…</p>}
        <button type="button" onClick={() => navigate("/inventory")}>
          Back
        </button>
      </section>
    );
  }

  const ask = typeof unit.ask_cents === "number" ? unit.ask_cents : null;
  const cost = typeof unit.acquisition_cost_cents === "number" ? unit.acquisition_cost_cents : null;
  const floor = typeof unit.floor_cents === "number" ? unit.floor_cents : null;

  return (
    <section className="page grid" style={{ maxWidth: 720 }}>
      <button type="button" onClick={() => navigate("/inventory")}>
        Back
      </button>
      <h1>SKU {sku}</h1>
      <p>
        {[unit.brand, unit.model].filter(Boolean).join(" ") || String(unit.title || "")}
      </p>
      <p className="muted">
        {String(unit.state || "")} · Ask {formatCents(ask) || "—"}
      </p>
      {error ? <p className="error">{error}</p> : null}
      {msg ? <p>{msg}</p> : null}

      {isAdmin ? (
        <>
          <label>
            Title
            <input
              defaultValue={String(unit.title || "")}
              onBlur={(e) => void saveField("title", e.target.value)}
              disabled={busy || !online}
            />
          </label>
          <label>
            Ask
            <input
              defaultValue={centsToInput(ask)}
              onBlur={(e) => {
                const c = parseMoneyToCents(e.target.value);
                if (typeof c === "number") void saveField("ask_cents", c);
              }}
              disabled={busy || !online}
            />
          </label>
          <label>
            Cost
            <input
              defaultValue={centsToInput(cost)}
              onBlur={(e) => {
                const c = parseMoneyToCents(e.target.value);
                if (c === undefined) return;
                void saveField("acquisition_cost_cents", c);
              }}
              disabled={busy || !online}
            />
          </label>
          <label>
            Floor
            <input
              defaultValue={centsToInput(floor)}
              onBlur={(e) => {
                const c = parseMoneyToCents(e.target.value);
                if (c === undefined) return;
                void saveField("floor_cents", c);
              }}
              disabled={busy || !online}
            />
          </label>
          <label>
            Condition
            <input
              defaultValue={String(unit.condition || "")}
              onBlur={(e) => void saveField("condition", e.target.value)}
              disabled={busy || !online}
            />
          </label>
          <label>
            Notes
            <input
              defaultValue={String(unit.defect_notes || "")}
              onBlur={(e) => void saveField("defect_notes", e.target.value)}
              disabled={busy || !online}
            />
          </label>
          <label className="row">
            <input type="checkbox" checked={unit.show_on_website === true} disabled={busy || !online}
              onChange={(e) => void saveField("show_on_website", String(e.target.checked))} />
            List online
          </label>
          <label>
            Sell online
            <select value={String(unit.fulfillment_override || "")} disabled={busy || !online}
              onChange={(e) => void saveField("fulfillment_override", e.target.value)}>
              <option value="">Automatic (ship if size/category allow)</option>
              <option value="ship">Force shippable</option>
              <option value="pickup">Store pickup only</option>
            </select>
          </label>
          {([["package_length_in", "Box length (in)"], ["package_width_in", "Box width (in)"], ["package_height_in", "Box height (in)"], ["package_weight_lb", "Box weight (lb)"]] as const).map(([field, label]) => (
            <label key={field}>
              {label}
              <input type="number" min="0.01" step="0.01" defaultValue={unit[field] == null ? "" : String(unit[field])}
                disabled={busy || !online} onBlur={(e) => void saveField(field, e.target.value)} />
            </label>
          ))}
          <label>
            Flat-rate shipping fallback ($; used only if live carrier rates are down)
            <input defaultValue={centsToInput(typeof unit.shipping_cents === "number" ? unit.shipping_cents : null)}
              disabled={busy || !online} onBlur={(e) => {
                const cents = parseMoneyToCents(e.target.value);
                if (cents !== undefined && (cents === null || cents > 0)) void saveField("shipping_cents", cents);
              }} />
          </label>
          <p className="muted">Every listed unit can be bought online for store pickup. Shipping is offered with live carrier rates once all four box numbers are filled in and the size/category rules allow it.</p>
          <label>
            Add photos from disk
            <input type="file" accept="image/*" multiple disabled={busy || !online} onChange={(e) => void onFiles(e.target.files)} />
          </label>
        </>
      ) : (
        <p className="muted">Clerks can view units but cannot edit cost, floor, or details.</p>
      )}

      <div className="row" style={{ flexWrap: "wrap" }}>
        {photos.map((p) => (
          <span key={p.id} className="muted">
            {p.is_primary ? "★ " : ""}
            {p.path.split("/").pop()}
          </span>
        ))}
      </div>
    </section>
  );
}
