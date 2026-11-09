import { DnsCheckbox } from './DnsCheckbox';
import { ReceiveWorkStatus } from './ReceiveWorkStatus';
import { useEffect, useRef, useState } from 'react';
import { ChannelCheckboxes } from './ChannelCheckboxes';
import { RestoreInventoryButton } from './RestoreInventoryButton';
import { UnitDispositionHistory } from './DispositionDialogs';
import { EbaySpecificsPanel } from './EbaySpecificsPanel';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { scannerInputMode } from './kiosk';
import { reportClientError } from './clientLog';
import { errText } from './errText';
import { reviewReasonLabel } from './inventoryReview';
import { DispositionButtons } from './DispositionDialogs';
import { QuantityPicker } from './ReceiveQuantity';
import { printUnitLabels } from './ReceiveGroupRow';
import { locationParts } from './locationOrder';
import {
  applyPartialLocationMove,
  applySimpleLocationChange,
  formatLocationSummary,
  singleBinOrUnassigned,
  unassignedQty,
} from './locationStock';
import { acquisitionCostCents as cents } from './missingCost';
import { profitAfterFeesCents } from './scanPricing';

const EDIT_SECTIONS = [
  { id: 'basics', label: 'Basics' },
  { id: 'price', label: 'Price' },
  { id: 'shipping', label: 'Shipping' },
  { id: 'ebay', label: 'eBay' },
  { id: 'stock', label: 'Stock' },
] as const;

type Photo = { id: number; path: string; is_primary: boolean; sort_order?: number; source?: string; source_url?: string };
type StockCandidate = { image_url: string; source_url: string; title: string; score: number };
type Unit = Record<string, unknown>;
type Options = { conditions: unknown; test_statuses: unknown };
type StockMovement = { id: number; type: string; delta: number; reason: string | null; reference: string | null; at: string; actor: string | null };

type Form = {
  upc: string; brand: string; model: string; title: string; description: string;
  price: string; cost: string; condition: string; testStatus: string;
  shippable: string; notes: string; length: string; width: string; height: string; weight: string;
};
type ChannelChoice = 'ebay' | 'amazon' | 'tiktok';
const CHANNELS: ChannelChoice[] = ['ebay','amazon','tiktok'];

function choices(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    try { return choices(JSON.parse(value)); } catch { return []; }
  }
  return [];
}

function moneyText(centsVal: unknown): string {
  if (centsVal == null || centsVal === '') return '';
  const n = Number(centsVal);
  if (!Number.isFinite(n)) return '';
  return (n / 100).toFixed(2);
}

function dimText(v: unknown): string {
  if (v == null || v === '') return '';
  return String(v);
}

function shipMode(unit: Unit): string {
  const o = String(unit.fulfillment_override || '').toLowerCase();
  if (o === 'ship') return 'ship';
  if (o === 'pickup') return 'pickup';
  return 'auto';
}

function fromUnit(unit: Unit): Form {
  return {
    upc: String(unit.upc || ''),
    brand: String(unit.brand || ''),
    model: String(unit.model || ''),
    title: String(unit.title || ''),
    description: String(unit.listing_body || unit.description || ''),
    price: moneyText(unit.ask_cents),
    cost: moneyText(unit.acquisition_cost_cents),
    condition: String(unit.condition || ''),
    testStatus: String(unit.test_status || ''),
    shippable: shipMode(unit),
    notes: String(unit.defect_notes || unit.notes || ''),
    length: dimText(unit.package_length_in),
    width: dimText(unit.package_width_in),
    height: dimText(unit.package_height_in),
    weight: dimText(unit.package_weight_lb),
  };
}

function blank(v: string) { return !v.trim(); }

function formatRetailAsOf(raw: unknown): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
}

function featuresText(features?: string[]) {
  const list = (features || []).map(f => f.trim()).filter(Boolean);
  return list.map(f => `• ${f}`).join('\n');
}

type LookupMerged = {
  title?: string | null; brand?: string | null; model?: string | null; description?: string | null;
  features?: string[]; asin?: string | null; msrp_cents?: number | null;
  retail_cents?: number | null; retail_source?: string | null; retail_as_of?: string | null;
  package?: { length_in?: number | null; width_in?: number | null; height_in?: number | null; weight_lb?: number | null };
};

export function UnitEditDrawer({
  client, storeId, sku, unit, photos, urls, accessToken, onClose, onSaved, onPhotosChanged,
  canDelete = false, onDeleted, appMode = false, missingFields = [], locationLabel, onReadinessChanged,
  initialSection,
}: {
  client: SupabaseClient;
  storeId: string;
  sku: string;
  unit: Unit;
  photos: Photo[];
  urls: Record<string, string>;
  accessToken: string;
  onClose: () => void;
  onSaved: (unit: Unit) => void;
  onPhotosChanged: () => void;
  /** Portal admins / managers only — hides Delete for register associates. */
  canDelete?: boolean;
  onDeleted?: () => void;
  /** Standalone Floor app: clear the bottom tab bar; use app chrome. */
  appMode?: boolean;
  missingFields?: string[];
  locationLabel?: string;
  onReadinessChanged?: (gaps?: string[]) => void;
  /** App item page can open Edit scrolled to a named section (photos/price/stock/ebay). */
  initialSection?: string;
}) {
  const [form, setForm] = useState<Form>(() => fromUnit(unit));
  const [options, setOptions] = useState<Options | null>(null);
  const [busy, setBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [stockSearchBusy, setStockSearchBusy] = useState(false);
  const [stockCandidates, setStockCandidates] = useState<StockCandidate[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [stockHistory, setStockHistory] = useState<StockMovement[]>([]);
  const [stockAddQty, setStockAddQty] = useState('1');
  const [convertQty, setConvertQty] = useState('2');
  const [stockAddCost, setStockAddCost] = useState('');
  const [stockAdjustMode, setStockAdjustMode] = useState<'set'|'delta'>('set');
  const [stockAdjustQty, setStockAdjustQty] = useState(String(Number(unit.qty_on_hand ?? 1) || 0));
  const [stockAdjustReason, setStockAdjustReason] = useState('count_correction');
  const [stockGiveQty, setStockGiveQty] = useState('1');
  const [stockGiveTo, setStockGiveTo] = useState('');
  const [quantitySheetOpen, setQuantitySheetOpen] = useState(false);
  const [quantityDraft, setQuantityDraft] = useState(String(Math.max(1, Number(unit.qty_on_hand ?? 1) || 1)));
  const [onlineExpanded, setOnlineExpanded] = useState(false);
  const [channelSelections, setChannelSelections] = useState<Record<ChannelChoice, boolean> | null>(null);
  const [dnsPending, setDnsPending] = useState<boolean | null>(null);
  const [locationAllocations, setLocationAllocations] = useState<{ location_code: string; quantity: number }[]>([]);
  const [locationOptions, setLocationOptions] = useState<{code:string;label:string}[]>([]);
  const [locationDraft, setLocationDraft] = useState('');
  const [locationMoveQty, setLocationMoveQty] = useState('1');
  const [locationMoveFrom, setLocationMoveFrom] = useState('__unassigned__');
  const [locationMoveTo, setLocationMoveTo] = useState('');
  const locationBaseline = useRef('');
  const specificsDirty = useRef(false);
  const specificsPersist = useRef<null | (() => Promise<void>)>(null);
  const upcEnrichment = useRef<{ specs: Record<string, unknown>; msrp: number | null; brand: string | null; model: string | null; title: string | null; description: string | null } | null>(null);
  const channelBaseline = useRef<Record<ChannelChoice, boolean> | null>(null);
  // The panel can change the description during Save; read it from here, not from the render's stale form.
  const latestDescription = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [viewPhoto, setViewPhoto] = useState<Photo | null>(null);
  const [activeSection, setActiveSection] = useState<string>('basics');
  const [dragPhotoId, setDragPhotoId] = useState<number | null>(null);
  const [specificsTouched, setSpecificsTouched] = useState(false);
  const upcInput = useRef<HTMLInputElement>(null);
  const onlineDetails = useRef<HTMLDetailsElement>(null);
  const detailScroll = useRef<HTMLElement | null>(null);
  const [currentMissing, setCurrentMissing] = useState(missingFields);
  const [descExpanded, setDescExpanded] = useState(false);
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
  const set = (key: keyof Form, value: string) => setForm(prev => ({ ...prev, [key]: value }));
  const jumpToGap = (gap: string) => {
    if (gap === 'category' || gap === 'category_review' || gap === 'specifics' || gap.startsWith('review_')) {
      if (onlineDetails.current) onlineDetails.current.open = true;
      window.setTimeout(() => document.getElementById('unit-edit-section-ebay')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        || document.querySelector('.unit-edit-online .ebay-specifics')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
      return;
    }
    if (gap === 'photo' || gap === 'photos') {
      document.getElementById('unit-edit-section-basics')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const target = gap === 'spec' ? 'unit-package-size' : document.querySelector(`[data-gap-target="${gap}"]`)?.id;
    if (target) document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const gapLabel: Record<string,string> = { photo:'photos', price:'price', brand:'brand', condition:'condition', category:'eBay category', category_review:'eBay category review', specifics:'eBay item specifics', spec:'package size for shipping', upc:'UPC', model:'model', title:'title', description:'description' };
  const baselineQty = String(Math.max(1, Number(unit.qty_on_hand ?? 1) || 1));
  const hasChanges = JSON.stringify(form) !== JSON.stringify(fromUnit(unit))
    || latestDescription.current != null
    || specificsDirty.current
    || specificsTouched
    || (channelSelections !== null && JSON.stringify(channelSelections) !== JSON.stringify(channelBaseline.current))
    || dnsPending !== null
    || quantityDraft !== baselineQty
    || locationDraft !== locationBaseline.current
    || locationMoveTo.trim() !== ''
    || upcEnrichment.current !== null;
  const unsavedCount = (() => {
    let n = 0;
    const initial = fromUnit(unit);
    for (const key of Object.keys(initial) as (keyof Form)[]) if (form[key] !== initial[key]) n += 1;
    if (latestDescription.current != null && latestDescription.current !== initial.description) n += 1;
    if (specificsDirty.current || specificsTouched) n += 1;
    if (channelSelections !== null && JSON.stringify(channelSelections) !== JSON.stringify(channelBaseline.current)) n += 1;
    if (dnsPending !== null) n += 1;
    if (quantityDraft !== baselineQty) n += 1;
    if (locationDraft !== locationBaseline.current || locationMoveTo.trim() !== '') n += 1;
    if (upcEnrichment.current !== null) n += 1;
    return Math.max(n, hasChanges ? 1 : 0);
  })();
  const cancel = () => {
    if (hasChanges && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  };
  const scrollToSection = (id: string) => {
    setActiveSection(id);
    document.getElementById(`unit-edit-section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => { setForm(fromUnit(unit)); setStockAdjustQty(String(Number(unit.qty_on_hand ?? 1) || 0)); setQuantityDraft(String(Math.max(1,Number(unit.qty_on_hand??1)||1)));setChannelSelections(null);setDnsPending(null);channelBaseline.current=null;upcEnrichment.current=null;setMsg(''); setError(''); setCurrentMissing(missingFields); setDescExpanded(false); setLocationPickerOpen(false); }, [sku]);
  useEffect(() => { setCurrentMissing(missingFields); }, [missingFields.join('|')]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const canQueryTables=typeof client.from==='function';
      const [stock, pick, bins, selection, dns] = await Promise.all([
        canQueryTables?client.from('unit_location_stock').select('location_code,quantity').eq('store_id',storeId).eq('sku',sku):Promise.resolve({data:[]}),
        canQueryTables?client.from('unit_pick_locations').select('location_code').eq('store_id',storeId).eq('sku',sku).maybeSingle():Promise.resolve({data:null}),
        canQueryTables?client.from('store_locations').select('code').eq('store_id',storeId).order('code'):Promise.resolve({data:[]}),
        canDelete ? client.rpc('portal_unit_channel_selections',{p_sku:sku}) : Promise.resolve({data:null,error:null}),
        canDelete ? client.rpc('portal_unit_dns',{p_sku:sku}) : Promise.resolve({data:null,error:null}),
      ]);
      if (!live) return;
      const allocations=(stock.data||[]).map(row=>({location_code:String(row.location_code),quantity:Number(row.quantity)||0}));
      const primary=allocations.length===1?allocations[0].location_code:(pick.data?.location_code?String(pick.data.location_code):'');
      setLocationAllocations(allocations);
      setLocationDraft(primary);
      locationBaseline.current=primary;
      setLocationMoveQty('1');
      setLocationMoveFrom(allocations[0]?.location_code || '__unassigned__');
      setLocationMoveTo('');
      setLocationOptions((bins.data||[]).map(row=>{const code=String(row.code);const parts=locationParts(code);return {code,label:parts?`${parts.display} · ${parts.slot}`:code};}));
      if(!selection.error&&selection.data){const src=selection.data as Record<string,{selected:boolean}>;channelBaseline.current=Object.fromEntries(CHANNELS.map(ch=>[ch,Boolean(src[ch]?.selected)])) as Record<ChannelChoice,boolean>;}
    })();return()=>{live=false;};
  },[client,storeId,sku,canDelete]);
  useEffect(() => {
    void client.rpc(canDelete ? 'portal_receive_options' : 'staff_receive_options').then(({ data, error: e }) => {
      if (!e && data) setOptions(data as Options);
    });
  }, [client, canDelete]);

  /** Fill only blank fields from a UPC lookup; never overwrite typed values. */
  async function attachUpc(raw: string) {
    const upc = raw.replace(/\s+/g, '');
    if (!/^\d{8,14}$/.test(upc)) {
      setError(`"${raw.trim()}" does not look like a UPC/EAN (8–14 digits).`);
      return;
    }
    setLookupBusy(true); setError(''); setMsg('');
    try {
      const res = await fetch(floorFunctionUrl('upc-lookup'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'lookup', upc, compare_upcitemdb: true }),
      });
      const json = await res.json().catch(() => ({} as { error?: string; message?: string; merged?: LookupMerged; gtin?: { upcA?: string } }));
      if (!res.ok) {
        const errMsg = json.error || json.message || `Lookup failed (${res.status})`;
        reportClientError(accessToken, { message: `upc_lookup failed: ${errMsg}`, page: 'inventory/unit', action_name: 'upc_attach', sku: upc });
        throw new Error(errMsg);
      }
      const m = json.merged || {};
      const pkg = m.package || {};
      const filled: string[] = [];
      setForm(prev => {
        const next = { ...prev };
        const put = (key: keyof Form, value: string | null | undefined, label: string) => {
          if (!value || !String(value).trim()) return;
          if (!blank(prev[key])) return;
          next[key] = String(value).trim();
          filled.push(label);
        };
        next.upc = upc;
        if (!prev.upc.trim()) filled.push('UPC');
        put('brand', m.brand, 'brand');
        put('model', m.model, 'model');
        put('title', m.title, 'title');
        const desc = (m.description || '').trim() || featuresText(m.features);
        put('description', desc, 'description');
        put('length', pkg.length_in != null ? String(pkg.length_in) : '', 'length');
        put('width', pkg.width_in != null ? String(pkg.width_in) : '', 'width');
        put('height', pkg.height_in != null ? String(pkg.height_in) : '', 'height');
        put('weight', pkg.weight_lb != null ? String(pkg.weight_lb) : '', 'weight');
        if (blank(prev.price) && m.retail_cents && m.retail_cents > 0) {
          // Suggest under retail; user still confirms via Save.
          const suggest = Math.ceil((Math.round(m.retail_cents * 0.55) + 1) / 100) * 100 - 1;
          if (suggest > 0 && suggest < m.retail_cents) {
            next.price = (suggest / 100).toFixed(2);
            filled.push('price');
          }
        }
        return next;
      });

      const specs: Record<string, unknown> = {
        upc,
        gtin: json.gtin?.upcA || upc,
        asin: m.asin || undefined,
        retail_cents: m.retail_cents || undefined,
        retail_source: m.retail_source || undefined,
        retail_as_of: m.retail_as_of || undefined,
        features: (m.features || []).filter(Boolean),
      };
      upcEnrichment.current = { specs, msrp: m.msrp_cents ?? null,
        brand: blank(form.brand) ? (m.brand || null) : null,
        model: blank(form.model) ? (m.model || null) : null,
        title: blank(form.title) ? (m.title || null) : null,
        description: blank(form.description) ? ((m.description || '').trim() || featuresText(m.features) || null) : null };

      setMsg(filled.length
        ? `Attached UPC ${upc}. Filled blank: ${filled.join(', ')}. Review and Save if price/cost look right.`
        : `Attached UPC ${upc}. Existing fields were kept (nothing overwritten).`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLookupBusy(false);
    }
  }

  async function save() {
    const ask = cents(form.price);
    const cost = cents(form.cost);
    if (ask === undefined) { setError('Price must look like 24.99 (blank = no price).'); return; }
    if (canDelete && cost === undefined) { setError('Cost must look like 9.00 (blank = unknown).'); return; }
    const dims = [form.length, form.width, form.height, form.weight].map(v => {
      const t = v.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    });
    if (dims.some(v => v === undefined)) {
      setError('Dimensions and weight must be positive numbers (or blank).');
      return;
    }
    if (quantityDraft.trim()) {
      const q=Number(quantityDraft);
      if(!Number.isInteger(q)||q<1||q>999){setError('Quantity must be a whole number from 1 to 999.');return;}
      if(!isStocked&&canDelete&&q>1&&!window.confirm(`Convert to stocked item with ${q} on hand?`)){setError('Quantity change cancelled.');return;}
    }
    // units.title is NOT NULL — never send blank/null. Prefer typed title, else brand + model, else SKU.
    const title = form.title.trim()
      || [form.brand, form.model].map((s) => s.trim()).filter(Boolean).join(' ')
      || `SKU ${sku}`;
    if (title !== form.title.trim()) {
      setForm((prev) => ({ ...prev, title }));
    }
    setBusy(true); setError(''); setMsg('');
    // brand/model/title are NOT NULL — always send strings ('' ok), never null/undefined.
    const { data, error: e } = canDelete
      ? await client.rpc('portal_update_unit', {
          p_sku: sku,
          p_upc: form.upc.trim(),
          p_brand: form.brand.trim(),
          p_model: form.model.trim(),
          p_title: title,
          p_description: latestDescription.current ?? form.description,
          p_ask_cents: ask,
          p_cost_cents: cost,
          p_condition: form.condition,
          p_test_status: form.testStatus,
          p_shippable: form.shippable,
          p_notes: form.notes,
          p_length: dims[0],
          p_width: dims[1],
          p_height: dims[2],
          p_weight: dims[3],
        })
      : await client.rpc('staff_update_unit', {
          p_sku: sku,
          p_upc: form.upc.trim(),
          p_brand: form.brand.trim(),
          p_model: form.model.trim(),
          p_title: title,
          p_description: latestDescription.current ?? form.description,
          p_ask_cents: ask,
          p_condition: form.condition,
          p_test_status: form.testStatus,
          p_notes: form.notes,
          p_length: dims[0],
          p_width: dims[1],
          p_height: dims[2],
          p_weight: dims[3],
        });
    if (e) { setBusy(false);setError(e.message); return; }
    const saved = data as Record<string, unknown>;
    try {
      if(upcEnrichment.current && canDelete){const payload=upcEnrichment.current;const {error:enrichError}=await client.rpc('portal_enrich_received_unit',{p_sku:sku,p_specs:payload.specs,p_msrp_cents:payload.msrp,p_brand:payload.brand,p_model:payload.model,p_title:payload.title,p_description:payload.description});if(enrichError)throw enrichError;upcEnrichment.current=null;}
      else { upcEnrichment.current = null; }
      if(canDelete) await specificsPersist.current?.();
      if(canDelete && channelSelections)for(const channel of CHANNELS){if(channelBaseline.current?.[channel]===channelSelections[channel])continue;const {error:channelError}=await client.rpc('portal_set_unit_channel_selection',{p_sku:sku,p_channel:channel,p_selected:channelSelections[channel]});if(channelError)throw channelError;}
      if(canDelete && dnsPending!==null){const {error:dnsError}=await client.rpc('portal_set_unit_dns',{p_sku:sku,p_dns:dnsPending});if(dnsError)throw dnsError;}
      if(canDelete && quantityDraft.trim()){
        const target=Number(quantityDraft);
        if(target!==stockQuantity){
          if(isStocked){const {error:qtyError}=await client.rpc('portal_stock_adjust',{p_sku:sku,p_mode:'set',p_quantity:target,p_reason:'count_correction'});if(qtyError)throw qtyError;}
          else if(target>1){const {error:qtyError}=await client.rpc('portal_stock_add',{p_sku:sku,p_quantity:target-stockQuantity,p_cost_cents:null});if(qtyError)throw qtyError;}
        }
      }
      const onHand=Math.max(1,Number(stockQuantity)||1);
      if(locationMoveTo.trim()){
        const qty=Number(locationMoveQty);
        if(!Number.isInteger(qty)||qty<1)throw new Error('Move quantity must be a whole number.');
        await applyPartialLocationMove(client,sku,qty,locationMoveFrom,locationMoveTo,locationAllocations,onHand);
      } else if(locationDraft!==locationBaseline.current){
        await applySimpleLocationChange(client,sku,onHand,locationAllocations,locationDraft);
      }
      if(locationMoveTo.trim() || locationDraft!==locationBaseline.current){
        const { data: stockRows } = await client.from('unit_location_stock').select('location_code,quantity').eq('store_id', storeId).eq('sku', sku);
        const nextAlloc=(stockRows||[]).map(row=>({location_code:String(row.location_code),quantity:Number(row.quantity)||0}));
        const primary=nextAlloc.length===1?nextAlloc[0].location_code:'';
        setLocationAllocations(nextAlloc);
        setLocationDraft(primary);
        locationBaseline.current=primary;
        setLocationMoveTo('');
        setLocationMoveFrom(nextAlloc[0]?.location_code || '__unassigned__');
      }
    } catch(saveError){setBusy(false);setError(errText(saveError));return;}
    setBusy(false);
    const { data: gaps, error: readinessError } = await client.rpc('portal_unit_readiness_gaps', { p_sku: sku });
    if (readinessError) {
      reportClientError(accessToken, { message: `Readiness refresh failed: ${readinessError.message}`, page: 'inventory/unit', action_name: 'readiness_refresh', sku });
    } else if (Array.isArray(gaps)) {
      setCurrentMissing(gaps as string[]);
      onReadinessChanged?.(gaps as string[]);
    }
    if (String(saved.title || '').trim() !== String(unit.title || '').trim()) {
      // A new title may now get an eBay category suggestion / generated description if those are still blank (never overwrites).
      void fetch(floorFunctionUrl('ebay-specifics'), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ store_id: storeId, sku, action: 'auto-fill' }) }).catch(() => {});
    }
    onSaved({
      ...unit,
      upc: saved.upc,
      brand: saved.brand,
      model: saved.model,
      title: saved.title,
      listing_body: saved.description,
      ask_cents: saved.ask_cents,
      acquisition_cost_cents: canDelete ? saved.cost_cents : unit.acquisition_cost_cents,
      condition: saved.condition,
      test_status: saved.test_status,
      defect_notes: saved.notes,
      package_length_in: saved.package_length_in,
      package_width_in: saved.package_width_in,
      package_height_in: saved.package_height_in,
      package_weight_lb: saved.package_weight_lb,
      fulfillment_override: saved.fulfillment_override,
      shippable: saved.shippable,
    });
    specificsDirty.current=false;setSpecificsTouched(false);setChannelSelections(null);setDnsPending(null);setQuantityDraft(String(Math.max(1,Number(quantityDraft)||1)));setMsg('Saved.');
  }

  async function clearEbayReview() {
    if (!canDelete) return;
    setBusy(true); setError(''); setMsg('');
    const { data, error: e } = await client.rpc('portal_clear_ebay_review', { p_sku: sku });
    setBusy(false);
    if (e) { setError(e.message); return; }
    const saved = data as { listing_specs?: unknown };
    onSaved({ ...unit, listing_specs: saved.listing_specs || {} });
    setMsg('eBay review cleared. Recheck the listing details before publishing.');
  }

  async function removeUnit() {
    if (!canDelete) return;
    if (!window.confirm(`Delete SKU ${sku} permanently?\n\nThis removes it from inventory. Items with any sales history cannot be deleted.`)) {
      return;
    }
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const { error: e } = await client.rpc('delete_unit', { p_sku: sku, p_approval_id: null });
      if (e) throw e;
      onDeleted?.();
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    // Snapshot before any await — FileList is live on the input.
    const picked = Array.from(files);
    setBusy(true); setError(''); setMsg('');
    let failed = 0;
    for (const file of picked) {
      const typeOk = !file.type || file.type.startsWith('image/');
      if (!typeOk || file.size > 15 * 1024 * 1024 || file.size < 1) { failed++; continue; }
      let body: Blob = file;
      try {
        // Detach from the <input> so clearing value cannot empty the blob (Android PWA).
        body = new Blob([await file.arrayBuffer()], { type: file.type || 'image/jpeg' });
      } catch { failed++; continue; }
      const safe = (file.name || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_') || 'photo.jpg';
      const path = `${storeId}/${sku}/${Date.now()}-${crypto.randomUUID()}-${safe}`;
      try {
        const upload = await client.storage.from('unit-photos').upload(path, body, {
          contentType: file.type || 'image/jpeg',
          upsert: false,
        });
        if (upload.error) throw upload.error;
        const linked = await client.rpc(canDelete ? 'portal_add_unit_photo' : 'staff_add_unit_photo', { p_sku: sku, p_path: path });
        if (linked.error) throw linked.error;
      } catch { failed++; }
    }
    setBusy(false);
    if (fileInput.current) fileInput.current.value = '';
    if (cameraInput.current) cameraInput.current.value = '';
    if (failed) setError(`${failed} photo(s) failed to upload.`);
    else setMsg('Photo(s) added.');
    onPhotosChanged();
  }

  async function findMoreStockPhotos() {
    setStockSearchBusy(true); setError(''); setStockCandidates([]);
    try {
      const response = await fetch(floorFunctionUrl('receive-photo-identify'), {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'find_more_stock_photos', sku }), signal: AbortSignal.timeout(30000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not search for product photos');
      setStockCandidates(Array.isArray(data.candidates) ? data.candidates : []);
      if (!data.candidates?.length) setMsg('No matching product photos found.');
    } catch (e) { setError(errText(e)); }
    finally { setStockSearchBusy(false); }
  }

  async function addStockCandidate(candidate: StockCandidate) {
    setBusy(true); setError(''); setMsg('');
    try {
      const response = await fetch(floorFunctionUrl('receive-photo-identify'), {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'add_more_stock_photo', sku, ...candidate }), signal: AbortSignal.timeout(45000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not add this photo');
      setStockCandidates(rows => rows.filter(row => row.image_url !== candidate.image_url));
      setMsg('Stock photo added.'); onPhotosChanged();
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  const stockQuantity = Math.max(0, Number(unit.qty_on_hand ?? 1) || 0);
  const isStocked = Boolean(unit.is_stocked) || stockQuantity > 1;
  const [depopHint, setDepopHint] = useState<{ live?: boolean; quantity?: number; stale?: boolean } | null>(null);
  useEffect(() => {
    if (!isStocked) { setDepopHint(null); return; }
    let alive = true;
    void client.rpc('portal_depop_quantity_hint', { p_sku: sku }).then(({ data }) => { if (alive) setDepopHint((data || null) as { live?: boolean; quantity?: number; stale?: boolean } | null); });
    return () => { alive = false; };
  }, [client, sku, isStocked, stockQuantity]);
  const refreshStockHistory = async () => {
    const { data, error: e } = await client.rpc('portal_stock_history', { p_sku: sku });
    if (!e) setStockHistory((data || []) as StockMovement[]);
  };
  useEffect(() => { if (isStocked) void refreshStockHistory(); }, [client, sku, isStocked]);

  async function addStock() {
    const quantity = Number(stockAddQty);
    const cost = cents(stockAddCost);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999 || cost === undefined) { setError('Enter a whole quantity from 1 to 999 and a valid optional cost each.'); return; }
    setBusy(true); setError('');
    const { data, error: e } = await client.rpc('portal_stock_add', { p_sku: sku, p_quantity: quantity, p_cost_cents: stockAddCost.trim() ? cost : null });
    setBusy(false);
    if (e) { setError(e.message); return; }
    onSaved({ ...unit, qty_on_hand: Number(data), is_stocked: true, state: 'available', ...(stockAddCost.trim() ? { acquisition_cost_cents: cost } : {}) });
    setStockAddQty('1'); setStockAddCost(''); setMsg(`${quantity} added. ${Number(data)} on hand.`); await refreshStockHistory(); onReadinessChanged?.();
  }

  async function adjustStock() {
    const quantity = Number(stockAdjustQty);
    if (!Number.isInteger(quantity) || (stockAdjustMode === 'set' && (quantity < 0 || quantity > 999)) || (stockAdjustMode === 'delta' && (quantity < -999 || quantity > 999)) || !stockAdjustReason) { setError('Enter a whole adjustment from 0 to 999 for a count, or −999 to 999 for a change.'); return; }
    setBusy(true); setError('');
    const { data, error: e } = await client.rpc('portal_stock_adjust', { p_sku: sku, p_mode: stockAdjustMode, p_quantity: quantity, p_reason: stockAdjustReason });
    setBusy(false);
    if (e) { setError(e.message); return; }
    onSaved({ ...unit, qty_on_hand: Number(data), state: Number(data) > 0 ? 'available' : 'voided' });
    setStockAdjustQty(String(Number(data))); setMsg(`Adjusted. ${Number(data)} on hand.`); await refreshStockHistory(); onReadinessChanged?.();
  }

  async function convertToStockedAtQuantity() {
    const quantity = Number(convertQty);
    if (!Number.isInteger(quantity) || quantity < 2 || quantity > 999) { setError('Enter a whole quantity from 2 to 999.'); return; }
    if (!window.confirm(`Convert to stocked item with ${quantity} on hand?`)) return;
    setBusy(true); setError('');
    const { data, error: e } = await client.rpc('portal_stock_add', { p_sku: sku, p_quantity: quantity - stockQuantity, p_cost_cents: null });
    setBusy(false);
    if (e) { setError(e.message); return; }
    onSaved({ ...unit, qty_on_hand: Number(data), is_stocked: true, state: 'available' });
    setConvertQty('2'); setMsg(`Converted to stocked item with ${Number(data)} on hand.`); await refreshStockHistory(); onReadinessChanged?.();
  }

  async function giveStockAway() {
    const quantity = Number(stockGiveQty);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > stockQuantity || !stockGiveTo.trim()) { setError('Enter a valid quantity and who it is going to.'); return; }
    if (!window.confirm(`Give away ${quantity} units to ${stockGiveTo.trim()}? Cost is recorded only if this item has a real cost.`)) return;
    setBusy(true); setError('');
    const { data, error: e } = await client.rpc('portal_stock_giveaway', { p_sku: sku, p_quantity: quantity, p_given_to: stockGiveTo.trim(), p_note: null });
    setBusy(false);
    if (e) { setError(e.message); return; }
    const result = data as { total_cost_cents: number | null; cost_missing: boolean };
    const next = stockQuantity - quantity;
    onSaved({ ...unit, qty_on_hand: next, state: next > 0 ? String(unit.state) : 'voided', show_on_website: next > 0 ? unit.show_on_website : false });
    setStockGiveQty('1'); setStockGiveTo('');
    setMsg(result.cost_missing ? `${quantity} given away. Cost is missing, so no expense was posted.` : `${quantity} given away · ${moneyText(result.total_cost_cents)} posted to Giveaways.`);
    await refreshStockHistory(); onReadinessChanged?.();
  }

  async function pullDefective() {
    if (!window.confirm(`Pull one unit from SKU ${sku} into a new one-of-one Defective SKU?`)) return;
    setBusy(true); setError('');
    const { data, error: e } = await client.rpc('portal_stock_pull_defective', { p_sku: sku });
    setBusy(false);
    if (e) { setError(e.message); return; }
    const next = stockQuantity - 1;
    onSaved({ ...unit, qty_on_hand: next, state: next > 0 ? String(unit.state) : 'voided', show_on_website: next > 0 ? unit.show_on_website : false });
    setMsg(`Pulled one unit into defective SKU ${String(data)}.`); await refreshStockHistory(); onReadinessChanged?.();
  }

  async function toggleStocked() {
    const on = !isStocked;
    if (!on && stockQuantity !== 1) { setError('A one-of-one item must have exactly one unit on hand.'); return; }
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_set_stocked', { p_sku: sku, p_on: on });
    setBusy(false); if (e) { setError(e.message); return; }
    onSaved({ ...unit, is_stocked: on }); await refreshStockHistory();
  }

  const conditions = choices(options?.conditions);
  const tests = choices(options?.test_statuses);
  const specs = typeof unit.listing_specs === 'object' && unit.listing_specs !== null
    ? unit.listing_specs as Record<string, unknown> : {};
  const reviewReason = reviewReasonLabel(specs.ebay_review_reason);
  const notForSale = String(specs.do_not_list || '').toLowerCase() === 'true' || String(specs.hold_reason || '') === 'do_not_list';
  const unsold = ['available', 'reserved', 'repair'].includes(String(unit.state || ''));
  const orderedPhotos = [...photos].sort((a, b) => Number(b.source === 'stock') - Number(a.source === 'stock') || Number(b.is_primary) - Number(a.is_primary) || (a.sort_order ?? a.id) - (b.sort_order ?? b.id));
  const statusLabel = notForSale ? 'Not for sale' : /^\s*(defective|scratch)/i.test(String(unit.condition||'')) ? 'Defective' : String(unit.state || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const liveProfit = profitAfterFeesCents(cents(form.price) ?? null, cents(form.cost) ?? null);
  const locationSummary = locationDraft
    ? formatLocationSummary(Math.max(1, Number(stockQuantity) || 1), locationAllocations.length ? locationAllocations : [{ location_code: locationDraft, quantity: Math.max(1, Number(stockQuantity) || 1) }])
    : (locationLabel || '');
  const locationEmpty = !(locationDraft || locationLabel || '').trim() || /unassigned/i.test(locationDraft || locationLabel || '');

  useEffect(() => {
    if (!appMode || !initialSection) return;
    const map: Record<string, string> = { photos: 'basics', photo: 'basics', price: 'price', shipping: 'shipping', ebay: 'ebay', stock: 'stock', location: 'stock' };
    const id = map[initialSection] || initialSection;
    const t = window.setTimeout(() => scrollToSection(id), 120);
    return () => window.clearTimeout(t);
  }, [appMode, initialSection, sku]);

  useEffect(() => {
    if (!appMode) return;
    const root = detailScroll.current;
    if (!root) return;
    const nodes = EDIT_SECTIONS.map((s) => document.getElementById(`unit-edit-section-${s.id}`)).filter(Boolean) as HTMLElement[];
    if (!nodes.length) return;
    const obs = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible?.target?.id) return;
      const id = visible.target.id.replace('unit-edit-section-', '');
      setActiveSection(id);
    }, { root: null, rootMargin: '-20% 0px -55% 0px', threshold: [0.1, 0.4, 0.7] });
    for (const n of nodes) obs.observe(n);
    return () => obs.disconnect();
  }, [appMode, sku, isStocked]);

  async function reorderPhotos(fromId: number, toId: number) {
    if (fromId === toId) return;
    const ordered = [...orderedPhotos];
    const from = ordered.findIndex((p) => p.id === fromId);
    const to = ordered.findIndex((p) => p.id === toId);
    if (from < 0 || to < 0) return;
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    const { error: e } = await client.rpc('reorder_unit_photos', { p_sku: sku, p_ids: ordered.map((p) => p.id) });
    if (e) setError(e.message);
    else onPhotosChanged();
  }

  return (
    <div
      className={`inventory-backdrop${appMode ? ' app-unit-edit' : ''}`}
      onMouseDown={e => { if (!appMode && e.target === e.currentTarget) cancel(); }}
    >
      <section ref={detailScroll} className="inventory-detail" role="dialog" aria-modal="true" aria-label={`Edit unit ${sku}`}>
        <div className="app-nav app-unit-edit-nav">
          <button type="button" onClick={cancel}>Cancel</button>
          <div className="app-nav-title">{appMode ? `Edit ${sku}` : `SKU ${sku}`}</div>
          <button type="button" disabled={busy || lookupBusy} onClick={() => void save()}>
            {busy ? '…' : 'Save'}
          </button>
        </div>

        {appMode && (
          <div className="app-edit-section-chips" role="tablist" aria-label="Edit sections">
            {EDIT_SECTIONS.filter((s) => canDelete || s.id !== 'ebay').map((s) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeSection === s.id}
                className={activeSection === s.id ? 'is-active' : undefined}
                key={s.id}
                onClick={() => scrollToSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        {appMode && (!form.upc.trim() || locationEmpty) && (
          <div className="app-edit-quick-adds">
            {!form.upc.trim() && (
              <button type="button" onClick={() => {
                scrollToSection('basics');
                window.setTimeout(() => upcInput.current?.focus(), 80);
              }}>+ Add UPC</button>
            )}
            {locationEmpty && (
              <button type="button" onClick={() => {
                scrollToSection('stock');
                setLocationPickerOpen(true);
                window.setTimeout(() => document.getElementById('unit-edit-location')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
              }}>+ Add location</button>
            )}
          </div>
        )}

        {error && <div className="alert" role="alert">{error}</div>}
        <div className="app-item-banner-slot"><ReceiveWorkStatus client={client} accessToken={accessToken} sku={sku} /></div>
        {msg && <p className="hint">{msg}</p>}

        {/* —— Photos / Basics —— */}
        <h3 id="unit-edit-section-basics" className={currentMissing.includes('photo') ? 'unit-edit-required' : ''}>{appMode ? 'Photos' : `Photos${currentMissing.includes('photo') ? ' · Required' : ''}`}</h3>
        <div className={appMode ? 'unit-edit-photo-grid' : 'unit-edit-photo-strip'}>
          {orderedPhotos.map((p, i) => (
            <button
              type="button"
              className="unit-edit-photo-open"
              key={p.id}
              draggable={appMode}
              onDragStart={() => setDragPhotoId(p.id)}
              onDragOver={(e) => { if (appMode) e.preventDefault(); }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragPhotoId != null) void reorderPhotos(dragPhotoId, p.id);
                setDragPhotoId(null);
              }}
              onClick={() => setViewPhoto(p)}
              aria-label={`View photo ${i + 1}`}
            >
              {urls[p.path] ? <img src={urls[p.path]} alt={`Unit ${sku}, photo ${i + 1}`} loading="lazy" /> : <span>Photo unavailable</span>}
              {(p.is_primary || p.source === 'stock') && <small>{p.source === 'stock' ? 'STOCK' : 'Primary'}</small>}
            </button>
          ))}
          <button type="button" className="unit-edit-photo-add" onClick={() => cameraInput.current?.click()} disabled={busy}>＋<small>Camera</small></button>
          <button type="button" className="unit-edit-photo-add" onClick={() => fileInput.current?.click()} disabled={busy}>▧<small>Library</small></button>
        </div>
        <input ref={cameraInput} type="file" accept="image/*" capture="environment" multiple hidden disabled={busy} onChange={e => void addPhotos(e.target.files)} />
        <input ref={fileInput} type="file" accept="image/*" multiple hidden disabled={busy} onChange={e => void addPhotos(e.target.files)} />
        {appMode ? (
          <div className="unit-edit-photo-tools">
            <span>Drag to reorder</span>
            {canDelete && (
              <button type="button" disabled={busy || stockSearchBusy} onClick={() => void findMoreStockPhotos()}>
                {stockSearchBusy ? 'Searching…' : 'Find stock photos'}
              </button>
            )}
          </div>
        ) : canDelete ? (
          <div className="unit-edit-stock-search">
            <button type="button" className="secondary" disabled={busy || stockSearchBusy} onClick={() => void findMoreStockPhotos()}>
              {stockSearchBusy ? 'Searching product photos…' : 'Find more stock photos'}
            </button>
          </div>
        ) : null}
        {canDelete && stockCandidates.length > 0 && <div className="unit-edit-stock-candidates" aria-label="Choose matching stock photo">
          {stockCandidates.map(candidate => <button type="button" key={candidate.image_url} disabled={busy}
            onClick={() => void addStockCandidate(candidate)} title={`${candidate.title} · Add this photo`}>
            <img src={candidate.image_url} alt={candidate.title || 'Possible product photo'} loading="lazy" />
            <span>{candidate.title || 'Possible match'} · Add</span>
          </button>)}
        </div>}

        {currentMissing.length > 0 && <div className="inventory-missing" role="status"><p>{currentMissing.length} listing details need attention. Fill the named fields and save.</p><div className="unit-edit-gap-links">{currentMissing.map(gap=><button type="button" className="text-button" key={gap} onClick={()=>jumpToGap(gap)}>Go to {gap==='specifics'?'eBay item specifics':gapLabel[gap] || reviewReasonLabel(gap) || gap}</button>)}</div></div>}
        {currentMissing.length === 0 && reviewReason && <p className="hint">eBay listing needs review: {reviewReason}.</p>}
        {reviewReason && canDelete ? <button type="button" className="secondary" disabled={busy} onClick={() => void clearEbayReview()}>I verified this issue · Clear eBay review</button> : null}

        <h3>{appMode ? 'Basics' : 'Product'}</h3>
        <div className="unit-edit-grid">
          <label className={appMode ? 'unit-edit-sku-hidden' : undefined}>SKU<input value={sku} readOnly className={appMode ? 'is-locked' : undefined} /></label>
          <label data-gap-target="title" id="unit-edit-title" className={`unit-edit-wide unit-edit-title-field${currentMissing.includes('title') ? ' unit-edit-required' : ''}`}>
            <span className="unit-edit-label-line">Title <small>{form.title.length} / 80</small></span>
            <textarea rows={appMode ? 2 : 2} maxLength={80} value={form.title} onChange={e => set('title', e.target.value)} />
            {currentMissing.includes('title') && <small>Required</small>}
          </label>
          <label data-gap-target="brand" id="unit-edit-brand" className={currentMissing.includes('brand') ? 'unit-edit-required' : ''}>Brand<input value={form.brand} onChange={e => set('brand', e.target.value)} />{currentMissing.includes('brand') && <small>Required</small>}{form.brand.trim() && form.brand.trim().toLowerCase() === form.title.trim().toLowerCase() && <small className="unit-edit-brand-hint">Looks like a product name, not a brand · <button type="button" onClick={() => set('brand', 'Unbranded')}>No brand</button></small>}</label>
          <label data-gap-target="model" id="unit-edit-model" className={currentMissing.includes('model') ? 'unit-edit-required' : ''}>Model<input value={form.model} onChange={e => set('model', e.target.value)} />{currentMissing.includes('model') && <small>Required</small>}</label>
          <label className="unit-edit-upc-row">UPC
            <div className="unit-edit-upc-fields">
              <input
                ref={upcInput}
                value={form.upc}
                onChange={e => set('upc', e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void attachUpc(form.upc);
                  }
                }}
                inputMode={scannerInputMode()}
                autoComplete="off"
                placeholder="Scan or type UPC"
                disabled={lookupBusy}
              />
              <button type="button" className={appMode ? undefined : 'secondary'} disabled={lookupBusy || !form.upc.trim()} onClick={() => void attachUpc(form.upc)}>
                {lookupBusy ? '…' : 'Look up'}
              </button>
            </div>
            {!appMode && <small className="unit-edit-helper">Look up fills only blank fields</small>}
          </label>
          <label data-gap-target="description" id="unit-edit-description" className={`unit-edit-wide unit-edit-notes${currentMissing.includes('description') ? ' unit-edit-required' : ''}`}>
            Description
            {appMode && !descExpanded ? (
              <>
                <div className="unit-edit-desc-clamp">{form.description || '—'}</div>
                {form.description.trim().length > 120 && (
                  <button type="button" className="unit-edit-show-all" onClick={() => setDescExpanded(true)}>Show all</button>
                )}
              </>
            ) : (
              <textarea rows={appMode ? 6 : 4} value={form.description} onChange={e => { latestDescription.current = e.target.value; set('description', e.target.value); }} />
            )}
            {currentMissing.includes('description') && <small>Required</small>}
          </label>
        </div>

        <h3>Condition</h3>
        {appMode ? (
          <div className="unit-edit-segmented" role="group" aria-label="Condition" data-gap-target="condition" id="unit-edit-condition">
            {conditions.map((c) => (
              <button type="button" key={c} className={form.condition === c ? 'is-active' : undefined} onClick={() => set('condition', c)}>{c}</button>
            ))}
            {form.condition && !conditions.includes(form.condition) && (
              <button type="button" className="is-active" onClick={() => undefined}>{form.condition}</button>
            )}
          </div>
        ) : (
          <div className="unit-edit-grid">
            <label data-gap-target="condition" id="unit-edit-condition" className={currentMissing.includes('condition') ? 'unit-edit-required' : ''}>Condition{currentMissing.includes('condition')&&!form.condition&&<i className="unit-edit-amber-dot"/>}
              <select value={form.condition} onChange={e => set('condition', e.target.value)}>
                <option value="">—</option>
                {conditions.map(c => <option key={c} value={c}>{c}</option>)}
                {form.condition && !conditions.includes(form.condition) && <option value={form.condition}>{form.condition}</option>}
              </select>
              {currentMissing.includes('condition') && <small>Required</small>}
            </label>
          </div>
        )}
        <div className="unit-edit-grid">
          <label className={appMode ? 'unit-edit-chevron-row' : undefined}>Test status{currentMissing.includes('test_status')&&!form.testStatus&&<i className="unit-edit-amber-dot"/>}
            <select value={form.testStatus} onChange={e => set('testStatus', e.target.value)}>
              <option value="">Not set</option>
              {tests.map(c => <option key={c} value={c}>{c}</option>)}
              {form.testStatus && !tests.includes(form.testStatus) && <option value={form.testStatus}>{form.testStatus}</option>}
            </select>
          </label>
        </div>

        {/* —— Price —— */}
        <h3 id="unit-edit-section-price">Price</h3>
        <div className={`unit-edit-grid${appMode ? ' unit-edit-price-pair' : ''}`}>
          <label data-gap-target="price" id="unit-edit-price" className={currentMissing.includes('price') ? 'unit-edit-required' : ''}>Price{isStocked ? ' (each)' : ''}<input inputMode="decimal" placeholder="24.99" value={form.price} onChange={e => set('price', e.target.value)} />{currentMissing.includes('price') && <small>Required</small>}</label>
          {canDelete && <label className={!form.cost.trim() ? 'unit-edit-cost-empty' : undefined}>Cost{isStocked ? ' (each)' : ''}<input inputMode="decimal" placeholder="Add cost" value={form.cost} onChange={e => set('cost', e.target.value)} /></label>}
        </div>
        {canDelete && typeof specs.retail_cents === 'number' && (
          <div className="unit-edit-reference-row">
            Manifest retail ${(Number(specs.retail_cents) / 100).toFixed(2)}{specs.retail_as_of ? ` · ${formatRetailAsOf(specs.retail_as_of)}` : ''}
          </div>
        )}
        {!canDelete && typeof specs.retail_cents === 'number' && !appMode && (
          <div className="unit-edit-reference-row">
            <span>Manifest retail</span>
            <strong>${(Number(specs.retail_cents) / 100).toFixed(2)}{specs.retail_as_of ? ` · ${formatRetailAsOf(specs.retail_as_of)}` : ''}</strong>
          </div>
        )}
        {canDelete && (
          <p className={`unit-edit-profit-line${!form.cost.trim() ? ' warn' : ''}`}>
            {!form.cost.trim()
              ? 'Add cost to see profit after fees'
              : `Profit after fees · $${((liveProfit ?? 0) / 100).toFixed(2)}`}
          </p>
        )}

        {/* —— Shipping —— */}
        <h3 id="unit-edit-section-shipping">{appMode ? 'Shipping' : 'Shipping box'}</h3>
        {canDelete && (
          <div className="unit-edit-grid">
            <label className={appMode ? 'unit-edit-chevron-row' : undefined}>Shippable
              <select value={form.shippable} onChange={e => set('shippable', e.target.value)}>
                <option value="auto">Automatic (rules)</option>
                <option value="ship">Yes — can ship</option>
                <option value="pickup">No — pickup only</option>
              </select>
            </label>
          </div>
        )}
        <div id="unit-package-size" className={`unit-edit-dim-row unit-edit-dimensions${appMode ? '' : ' unit-edit-grid'}`}>
          <label>{appMode ? 'L' : 'L in'}<input aria-label="Box length in" inputMode="decimal" value={form.length} onChange={e => set('length', e.target.value)} /></label>
          <label>{appMode ? 'W' : 'W in'}<input aria-label="Box width in" inputMode="decimal" value={form.width} onChange={e => set('width', e.target.value)} /></label>
          <label>{appMode ? 'H' : 'H in'}<input aria-label="Box height in" inputMode="decimal" value={form.height} onChange={e => set('height', e.target.value)} /></label>
          <label>lb<input aria-label="Package weight lb" inputMode="decimal" value={form.weight} onChange={e => set('weight', e.target.value)} /></label>
        </div>
        <small className="unit-edit-wide unit-edit-helper">{appMode ? 'Packed box — L × W × H in — lb. Buyers pay shipping from the packed box.' : 'The packed box, not the product. Buyers pay shipping from this.'}</small>
        {canDelete && appMode && (
          <DnsCheckbox
            client={client}
            sku={sku}
            pendingValue={dnsPending ?? undefined}
            onPendingChange={setDnsPending}
            onChanged={() => onReadinessChanged?.()}
            variant="switch"
          />
        )}
        {!appMode && (
          <label className="unit-edit-wide unit-edit-notes">Notes<textarea rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} /></label>
        )}

        {/* —— eBay —— */}
        {canDelete && (
          <div id="unit-edit-section-ebay" className={appMode ? 'unit-edit-ebay-block' : undefined}>
            {appMode ? <h3>eBay &amp; channels</h3> : null}
            <details
              ref={onlineDetails}
              className={`unit-edit-online${appMode ? ' app-ebay-open' : ''}`}
              open={appMode ? true : onlineExpanded}
              onToggle={(e) => {
                if (!appMode) setOnlineExpanded(e.currentTarget.open);
              }}
            >
              <summary>{notForSale ? 'Not listed online' : (appMode ? 'Channels' : 'Selling online')}</summary>
              {!notForSale && <>
                {appMode && (
                  <ChannelCheckboxes key={`${sku}-app`} client={client} sku={sku} appMode={appMode} pendingSelections={{ current: channelSelections }} onPendingChange={setChannelSelections} />
                )}
                <EbaySpecificsPanel client={client} sku={sku} storeId={storeId} appMode={appMode} hideSaveButton hideBrandAspect={appMode} onDescription={(t) => { latestDescription.current = t; set('description', t); }} onJumpToCondition={() => jumpToGap('condition')} persistRef={specificsPersist} dirtyRef={specificsDirty} onDirtyChange={setSpecificsTouched} onSaved={onReadinessChanged} />
                {!appMode && <DnsCheckbox client={client} sku={sku} pendingValue={dnsPending??undefined} onPendingChange={setDnsPending} onChanged={() => onReadinessChanged?.()} />}
                {!appMode && <ChannelCheckboxes key={sku} client={client} sku={sku} appMode={appMode} pendingSelections={{current:channelSelections}} onPendingChange={setChannelSelections}/>}
              </>}
              {notForSale && <p className="hint">Not listed online (do not list).</p>}
            </details>
          </div>
        )}

        {/* —— Stock —— */}
        <h3 id="unit-edit-section-stock">Stock</h3>
        {appMode ? (
          <section className="unit-stock-card unit-stock-card-clean" aria-label="Stock quantity">
            <div className="unit-stock-onhand-row">
              <span className="unit-stock-label">On hand</span>
              <div className="unit-stock-stepper">
                <button type="button" aria-label="Decrease quantity" disabled={!canDelete || busy || Number(quantityDraft) <= (isStocked ? 0 : 1)} onClick={() => setQuantityDraft(String(Math.max(isStocked ? 0 : 1, Number(quantityDraft || stockQuantity) - 1)))}>−</button>
                <button type="button" className="unit-edit-quantity-display" disabled={!canDelete} onClick={() => { setQuantityDraft(String(stockQuantity)); setQuantitySheetOpen(true); }}>{quantityDraft}</button>
                <button type="button" aria-label="Increase quantity" disabled={!canDelete || busy || Number(quantityDraft) >= 999} onClick={() => setQuantityDraft(String(Math.min(999, Number(quantityDraft || stockQuantity) + 1)))}>+</button>
              </div>
            </div>
          </section>
        ) : (
          <section className="unit-stock-card" aria-label="Stock quantity">
            <button type="button" className="unit-quantity-step" aria-label="Decrease quantity" disabled={!canDelete || busy || Number(quantityDraft)<= (isStocked ? 0 : 1)} onClick={()=>setQuantityDraft(String(Math.max(isStocked ? 0 : 1, Number(quantityDraft||stockQuantity)-1)))}>−</button>
            <div className="unit-stock-center">
              <span className="unit-stock-label">On hand</span>
              <button type="button" className="unit-edit-quantity-display" disabled={!canDelete} onClick={()=>{setQuantityDraft(String(stockQuantity));setQuantitySheetOpen(true);}}>{quantityDraft}</button>
              <small className="unit-stock-helper">
                {isStocked
                  ? <>{stockHistory.filter(m => m.type === 'sold').reduce((n,m) => n + Math.abs(m.delta),0)} sold · {stockHistory.filter(m => ['received','opening_balance','added'].includes(m.type)).reduce((n,m) => n + Math.max(m.delta,0),0)} received</>
                  : <>One-of-one. Above 1 makes it a stocked SKU.</>}
              </small>
              {depopHint?.live && <p role="status">Depop: set quantity to {depopHint.quantity ?? stockQuantity}.{depopHint.stale ? ' Floor count changed — update Depop.' : ''}</p>}
            </div>
            <button type="button" className="unit-quantity-step" aria-label="Increase quantity" disabled={!canDelete || busy || Number(quantityDraft)>=999} onClick={()=>setQuantityDraft(String(Math.min(999,Number(quantityDraft||stockQuantity)+1)))}>+</button>
            <button type="button" className="secondary" disabled={!stockQuantity} onClick={() => void printUnitLabels(Array.from({ length: Math.min(stockQuantity,1000) }, () => sku), String(unit.title || `SKU ${sku}`)).catch(e => setError(e.message))}>Labels · {stockQuantity}</button>
            {isStocked && canDelete && <button type="button" className="secondary" disabled={busy || stockQuantity !== 1} onClick={() => void toggleStocked()}>Convert to one-of-one</button>}
            {isStocked && canDelete && <div className="unit-stock-actions"><QuantityPicker value={stockAddQty} onChange={setStockAddQty} maximum={999} label="Add quantity"/><label>Optional cost each<input inputMode="decimal" placeholder="No cost change" value={stockAddCost} onChange={e => setStockAddCost(e.target.value)} /></label><button type="button" disabled={busy} onClick={() => void addStock()}>Add stock</button></div>}
            {isStocked && canDelete && <div className="unit-stock-actions"><select aria-label="Adjustment mode" value={stockAdjustMode} onChange={e => { const next=e.target.value as 'set'|'delta';setStockAdjustMode(next);setStockAdjustQty(next==='delta'?'0':String(stockQuantity)); }}><option value="set">Set quantity</option><option value="delta">Add or remove</option></select><QuantityPicker value={stockAdjustQty} onChange={setStockAdjustQty} minimum={stockAdjustMode==='set'?0:-999} maximum={999} label="Adjustment quantity"/><select aria-label="Adjustment reason" value={stockAdjustReason} onChange={e => setStockAdjustReason(e.target.value)}><option value="count_correction">Count correction</option><option value="damaged">Damaged</option><option value="lost">Lost</option><option value="other">Other</option></select><button type="button" disabled={busy} onClick={() => void adjustStock()}>Adjust</button></div>}
            {isStocked && canDelete && <div className="unit-stock-actions"><QuantityPicker value={stockGiveQty} onChange={setStockGiveQty} maximum={Math.min(999,stockQuantity)} label="Give away quantity"/><label>Given to<input value={stockGiveTo} onChange={e => setStockGiveTo(e.target.value)} /></label><button type="button" disabled={busy || !stockQuantity} onClick={() => void giveStockAway()}>Give away</button><button type="button" className="secondary" disabled={busy || !stockQuantity} onClick={() => void pullDefective()}>Pull 1 as defective</button></div>}
            {isStocked && <details className="unit-stock-history"><summary>Stock movement history</summary>{stockHistory.map(move => <div className="ledger-row" key={move.id}><strong>{move.type.replaceAll('_',' ')} · {move.delta > 0 ? '+' : ''}{move.delta}</strong><span>{move.actor || 'System'} · {move.reference || move.reason || ''} · {new Date(move.at).toLocaleString()}</span></div>)}</details>}
          </section>
        )}

        <div className={`unit-edit-grid${appMode ? ' unit-edit-stock-meta' : ''}`}>
          <div className="unit-edit-wide unit-edit-status-row">
            <span>Status</span>
            <strong>{statusLabel}</strong>
          </div>
          {appMode ? (
            <div id="unit-edit-location" className="unit-edit-wide">
              <button type="button" className="unit-edit-location-row" onClick={() => setLocationPickerOpen((v) => !v)}>
                <span>Location</span>
                <strong className={locationEmpty ? 'warn' : undefined}>
                  {locationEmpty ? 'Unassigned ›' : `${locationSummary || locationDraft} ›`}
                </strong>
              </button>
              {locationPickerOpen && (
                singleBinOrUnassigned(locationAllocations, Math.max(1, Number(stockQuantity) || 1)) ? (
                  <label className="unit-edit-location-picker">Bay<select value={locationDraft} onChange={(e) => { setLocationDraft(e.target.value); setLocationPickerOpen(false); }}>
                    <option value="">Unassigned</option>
                    {locationOptions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                  </select></label>
                ) : (
                  <div className="unit-edit-grid">
                    <label>Move quantity<input inputMode="numeric" type="number" min="1" step="1" value={locationMoveQty} onChange={(e) => setLocationMoveQty(e.target.value)} /></label>
                    <label>From<select value={locationMoveFrom} onChange={(e) => setLocationMoveFrom(e.target.value)}>
                      {unassignedQty(Math.max(1, Number(stockQuantity) || 1), locationAllocations) > 0 && <option value="__unassigned__">Unassigned</option>}
                      {locationAllocations.map((row) => <option key={row.location_code} value={row.location_code}>{row.location_code} · {row.quantity}</option>)}
                    </select></label>
                    <label>To<select value={locationMoveTo} onChange={(e) => setLocationMoveTo(e.target.value)}>
                      <option value="">—</option>
                      <option value="__unassigned__">Unassigned</option>
                      {locationOptions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                    </select></label>
                  </div>
                )
              )}
            </div>
          ) : (
            <div id="unit-edit-location" className="unit-edit-wide unit-edit-location">
              <span>Location</span>
              <p className={locationEmpty ? 'warn' : undefined}>
                {locationEmpty ? 'Unassigned' : formatLocationSummary(Math.max(1, Number(stockQuantity) || 1), locationAllocations)}
                {locationEmpty ? ' · Assign' : ''}
              </p>
              {singleBinOrUnassigned(locationAllocations, Math.max(1, Number(stockQuantity) || 1)) ? (
                <label>Location<select value={locationDraft} onChange={(e) => setLocationDraft(e.target.value)}>
                  <option value="">Unassigned</option>
                  {locationOptions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                </select></label>
              ) : (
                <div className="unit-edit-grid">
                  <label>Move quantity<input inputMode="numeric" type="number" min="1" step="1" value={locationMoveQty} onChange={(e) => setLocationMoveQty(e.target.value)} /></label>
                  <label>From<select value={locationMoveFrom} onChange={(e) => setLocationMoveFrom(e.target.value)}>
                    {unassignedQty(Math.max(1, Number(stockQuantity) || 1), locationAllocations) > 0 && <option value="__unassigned__">Unassigned</option>}
                    {locationAllocations.map((row) => <option key={row.location_code} value={row.location_code}>{row.location_code} · {row.quantity}</option>)}
                  </select></label>
                  <label>To<select value={locationMoveTo} onChange={(e) => setLocationMoveTo(e.target.value)}>
                    <option value="">—</option>
                    <option value="__unassigned__">Unassigned</option>
                    {locationOptions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                  </select></label>
                  <small className="unit-edit-wide">Choose From/To and save to move units. Same history as the Locations tab.</small>
                </div>
              )}
            </div>
          )}
        </div>

        {appMode && (
          <label className="unit-edit-wide unit-edit-notes unit-edit-notes-block">Notes<textarea rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Anything the next person should know" /></label>
        )}

        {quantitySheetOpen&&<div className="unit-quantity-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setQuantitySheetOpen(false);}}><section className="unit-quantity-sheet" role="dialog" aria-modal="true" aria-label="Quantity on hand"><div className="unit-quantity-grabber"/><h2>Quantity on hand</h2><p>{String(unit.title||`SKU ${sku}`)} · SKU {sku}</p><div className="unit-quantity-wheel"><select aria-label="Quantity 1 to 100" size={5} value={Number(quantityDraft)<=100?quantityDraft:''} onChange={e=>e.target.value&&setQuantityDraft(e.target.value)}>{Array.from({length:100},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}</option>)}</select></div><label>Or type a number (up to 999)<input aria-label="Typed on hand quantity" type="number" inputMode="numeric" min="1" max="999" step="1" value={quantityDraft} onChange={e=>setQuantityDraft(e.target.value)}/></label>{!isStocked&&<small>This item is one-of-one. Saving more than 1 converts it to a stocked SKU and logs the change.</small>}<div className="unit-quantity-actions"><button type="button" className="secondary" onClick={()=>setQuantitySheetOpen(false)}>Cancel</button><button type="button" onClick={()=>{setQuantitySheetOpen(false);void save();}}>Set {quantityDraft||'0'} on hand</button></div></section></div>}

        {canDelete && <h3>Actions</h3>}
        <div className="unit-edit-bottom-actions">
          {canDelete && unit.state === 'sold' && <RestoreInventoryButton client={client} sku={sku} onDone={() => { onSaved({ ...unit, state: 'available' }); onClose(); }} />}
          {canDelete && unsold && <DispositionButtons client={client} sku={sku} money={n => `$${(n / 100).toFixed(2)}`} stamp={s => new Date(s).toLocaleDateString()} className="secondary" presentation={appMode ? 'rows' : 'buttons'} onDone={() => { onReadinessChanged?.(); onDeleted?.(); onClose(); }} />}
          {canDelete && <button type="button" className="text-button danger unit-edit-delete" disabled={busy || lookupBusy} onClick={() => void removeUnit()}>Delete item</button>}
        </div>
        {canDelete && <UnitDispositionHistory client={client} sku={sku} stamp={s => new Date(s).toLocaleString()} />}

        {appMode && hasChanges && (
          <div className="app-sticky-save" role="status">
            <span>{unsavedCount} unsaved change{unsavedCount === 1 ? '' : 's'}</span>
            <button type="button" disabled={busy || lookupBusy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        )}

        {viewPhoto && <div className="unit-photo-lightbox" role="dialog" aria-modal="true" aria-label="Photo controls"><button type="button" className="unit-photo-lightbox-close" onClick={() => setViewPhoto(null)}>Close</button>{urls[viewPhoto.path] && <img src={urls[viewPhoto.path]} alt={`Unit ${sku}`} />}<div><button type="button" disabled={busy} onClick={async () => { const { error: e } = await client.rpc('set_primary_photo', { p_id: viewPhoto.id }); if (e) setError(e.message); else { setViewPhoto(null); onPhotosChanged(); } }}>Make primary</button><button type="button" disabled={busy} onClick={async () => { const { error: e } = await client.rpc('delete_unit_photo', { p_id: viewPhoto.id }); if (e) setError(e.message); else { await client.storage.from('unit-photos').remove([viewPhoto.path]); setViewPhoto(null); onPhotosChanged(); } }}>Delete photo</button><button type="button" className="secondary" disabled={busy} onClick={async () => { const ordered = [...orderedPhotos]; const i = ordered.findIndex(p => p.id === viewPhoto.id); if (i > 0) { [ordered[i - 1], ordered[i]] = [ordered[i], ordered[i - 1]]; const { error: e } = await client.rpc('reorder_unit_photos', { p_sku: sku, p_ids: ordered.map(p => p.id) }); if (e) setError(e.message); else onPhotosChanged(); } }}>Move earlier</button></div></div>}
      </section>
    </div>
  );
}
