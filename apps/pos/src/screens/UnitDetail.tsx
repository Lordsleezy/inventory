import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { centsToInput, formatCents, parseMoneyToCents } from "@floor/store";
import { authErrorMessage, floorCloud, storagePathForPhoto, webDerivativePaths } from "@floor/cloud";
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
  const [photos, setPhotos] = useState<{ id: number; path: string; is_primary: boolean; sort_order: number; src: string }[]>([]);
  const [newAspect, setNewAspect] = useState('');

  async function load() {
    const sb = floorCloud();
    const table = isAdmin ? "units" : "units_pos";
    const { data, error: err } = await sb.from(table).select("*").eq("sku", sku).maybeSingle();
    if (err) setError(err.message);
    else setUnit(data);
    const { data: ph } = await sb.from("photos").select("id, path, is_primary, sort_order").eq("sku", sku)
      .order("is_primary", { ascending: false }).order("sort_order").order("id");
    setPhotos(await Promise.all((ph ?? []).map(async row => {
      const signed = await sb.storage.from('unit-photos').createSignedUrl(row.path,3600);
      return { ...row,src:signed.data?.signedUrl || '' };
    })));
  }

  useEffect(() => {
    void load();
  }, [sku, isAdmin]);

  const clerkFields = new Set(["condition", "test_status", "location", "defect_notes", "qty_on_hand", "ask_cents"]);

  async function saveField(field: string, value: string | number | null) {
    if (!isAdmin && !clerkFields.has(field)) return;
    setBusy(true);
    setError("");
    try {
      const rpc = ["ai_description", "ebay_title", "ebay_category", "ebay_item_specifics"].includes(field)
        ? "update_enriched_unit_field"
        : "update_unit_field";
      const { error: rpcErr } = await floorCloud().rpc(rpc, {
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

  async function primary(id: number) {
    setBusy(true);setError('');
    try {const {error}=await floorCloud().rpc('set_primary_photo',{p_id:id});if(error)throw error;await load()}
    catch(err){setError(authErrorMessage(err))}finally{setBusy(false)}
  }

  async function move(id: number,direction: -1|1) {
    const ordered=[...photos].sort((a,b)=>a.sort_order-b.sort_order||a.id-b.id);
    const index=ordered.findIndex(photo=>photo.id===id),other=index+direction;
    if(index<0||other<0||other>=ordered.length)return;
    [ordered[index],ordered[other]]=[ordered[other],ordered[index]];
    setBusy(true);setError('');
    try {const {error}=await floorCloud().rpc('reorder_unit_photos',{p_sku:sku,p_ids:ordered.map(photo=>photo.id)});
      if(error)throw error;await load()}
    catch(err){setError(authErrorMessage(err))}finally{setBusy(false)}
  }

  async function removePhoto(photo: typeof photos[number]) {
    if(!window.confirm('Delete this photo?'))return;
    setBusy(true);setError('');
    try {const {error}=await floorCloud().rpc('delete_unit_photo',{p_id:photo.id});if(error)throw error;
      if(/^[0-9a-f-]{36}\//i.test(photo.path))await floorCloud().storage.from('unit-photos')
        .remove([photo.path,...webDerivativePaths(photo.path)]);
      await load()}
    catch(err){setError(authErrorMessage(err))}finally{setBusy(false)}
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
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
  const value = typeof unit.msrp_cents === "number" ? unit.msrp_cents : null;
  const cost = typeof unit.acquisition_cost_cents === "number" ? unit.acquisition_cost_cents : null;
  const floor = typeof unit.floor_cents === "number" ? unit.floor_cents : null;
  const specifics = unit.ebay_item_specifics && typeof unit.ebay_item_specifics === 'object'
    ? unit.ebay_item_specifics as Record<string,string> : {};
  async function saveSpecifics(next:Record<string,string>){await saveField('ebay_item_specifics',JSON.stringify(next))}

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
        {unit.location ? ` · ${String(unit.location)}` : ""}
        {typeof unit.qty_on_hand === "number" && unit.qty_on_hand > 1 ? ` · qty ${unit.qty_on_hand}` : ""}
      </p>
      {error ? <p className="error">{error}</p> : null}
      {msg ? <p>{msg}</p> : null}

      {!isAdmin ? (
        <>
          <p className="muted">Clerks can set selling price, location, condition, quantity, notes, and photos. Cost is admin-only.</p>
          <label>
            Price (ask)
            <input
              defaultValue={centsToInput(ask)}
              onBlur={(e) => {
                const c = parseMoneyToCents(e.target.value);
                if (c !== undefined) void saveField("ask_cents", c);
              }}
              disabled={busy || !online}
            />
          </label>
          <label>
            Location
            <input
              defaultValue={String(unit.location || "")}
              onBlur={(e) => void saveField("location", e.target.value)}
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
            Quantity
            <input
              defaultValue={unit.qty_on_hand == null ? "1" : String(unit.qty_on_hand)}
              inputMode="numeric"
              onBlur={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) void saveField("qty_on_hand", n);
              }}
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
          <label>
            Add photos from disk
            <input type="file" accept="image/*" multiple disabled={busy || !online} onChange={(e) => void onFiles(e.target.files)} />
          </label>
        </>
      ) : null}

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
          {([['brand','Brand'],['model','Model'],['category','Category'],['test_status','Test status']] as const)
            .map(([field,label])=><label key={field}>{label}<input key={`${field}-${unit.updated_at}`}
              defaultValue={String(unit[field]||'')} disabled={busy||!online}
              onBlur={e=>void saveField(field,e.target.value)} /></label>)}
          <label>Description<textarea key={`description-${unit.updated_at}`} rows={5}
            defaultValue={String(unit.listing_body||unit.ai_description||'')}
            disabled={busy||!online} onBlur={e=>void saveField('listing_body',e.target.value)} /></label>
          <label>Value (highest retail price)
            <input key={`value-${unit.updated_at}`} defaultValue={centsToInput(value)}
              inputMode="decimal" disabled={busy||!online} onBlur={e=>{
                const c=parseMoneyToCents(e.target.value);if(c!==undefined)void saveField('msrp_cents',c);
              }} />
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
          {unit.dims_source==='estimated' ? <p className="error">Estimated dimensions — check before shipping.</p> : null}
          {([['product_height_in','Product height (in)'],['product_width_in','Product width (in)'],
            ['product_depth_in','Product depth (in)'],['product_weight_lb','Product weight (lb)']] as const)
            .map(([field,label])=><label key={field}>{label}{String((unit.listing_specs as any)?.dims_sources?.[field]||'').startsWith('estimated')?' · estimated — check':''}<input type="number" min="0.01" step="0.01"
              key={`${field}-${unit.updated_at}`} defaultValue={unit[field]==null?'':String(unit[field])}
              disabled={busy||!online} onBlur={e=>void saveField(field,e.target.value)} /></label>)}
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
              {label}{String((unit.listing_specs as any)?.dims_sources?.[field]||'').startsWith('estimated')?' · estimated — check':''}
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
          <label>eBay title<input key={`ebay-title-${unit.updated_at}`} maxLength={80}
            defaultValue={String(unit.ebay_title||'')} disabled={busy||!online}
            onBlur={e=>void saveField('ebay_title',e.target.value)} /></label>
          <label>eBay category<input key={`ebay-cat-${unit.updated_at}`}
            defaultValue={String(unit.ebay_category||'')} disabled={busy||!online}
            onBlur={e=>void saveField('ebay_category',e.target.value)} /></label>
          <div className="grid"><strong>eBay item specifics</strong>
            {Object.entries(specifics).map(([name,item])=><label key={name}>{name}
              <input key={`${name}-${unit.updated_at}`} defaultValue={String(item)} disabled={busy||!online}
                onBlur={e=>void saveSpecifics({...specifics,[name]:e.target.value})} /></label>)}
            <label>Add specific<input value={newAspect} disabled={busy||!online}
              onChange={e=>setNewAspect(e.target.value)} placeholder="e.g. Size" /></label>
            {newAspect.trim() ? <button type="button" disabled={busy||!online} onClick={()=>{
              void saveSpecifics({...specifics,[newAspect.trim()]:''}).then(()=>setNewAspect(''));
            }}>Add</button> : null}
          </div>
          <label>
            Quantity
            <input
              defaultValue={unit.qty_on_hand == null ? "1" : String(unit.qty_on_hand)}
              inputMode="numeric"
              onBlur={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) void saveField("qty_on_hand", n);
              }}
              disabled={busy || !online}
            />
          </label>
          <label>
            Location
            <input
              defaultValue={String(unit.location || "")}
              onBlur={(e) => void saveField("location", e.target.value)}
              disabled={busy || !online}
            />
          </label>
          <label>
            Add photos from disk
            <input type="file" accept="image/*" multiple disabled={busy || !online} onChange={(e) => void onFiles(e.target.files)} />
          </label>
        </>
      ) : null}

      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
        {photos.map((photo) => (
          <div key={photo.id} style={{ width: 136 }}>
            {photo.src ? <img src={photo.src} alt={'SKU ' + sku + ' photo'}
              style={{ width: 128, height: 128, objectFit: 'cover' }} />
              : <span className="muted">Photo unavailable</span>}
            <div>{photo.is_primary ? '★ Main photo' : ''}</div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button type="button" disabled={busy || !online || photo.is_primary}
                onClick={() => void primary(photo.id)}>Main</button>
              <button type="button" disabled={busy || !online}
                onClick={() => void move(photo.id, -1)}>←</button>
              <button type="button" disabled={busy || !online}
                onClick={() => void move(photo.id, 1)}>→</button>
              {isAdmin ? (
                <button type="button" disabled={busy || !online}
                  onClick={() => void removePhoto(photo)}>Delete</button>
              ) : null}
            </div>
          </div>
        ))}
      </div>   </section>
  );
}
