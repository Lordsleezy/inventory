import type { OutboxRow, OutboxStatus } from "./outbox.ts";
import { DEFAULT_LEGAL, type PaperKind } from "./receipt.ts";

export type CachedUnit = {
  sku: string;
  title: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  condition: string | null;
  askCents: number | null;
  state: string;
  qtyOnHand?: number;
  photoUrl?: string | null;
};

export type PosSettings = {
  paperKind: PaperKind;
  charsPerLine: number | null;
  printerPath: string;
  reviewUrl: string;
  receiptLegal: string;
  terminalDeviceId: string;
  taxRateBps: number;
};

export type PrintResult = {
  printed: boolean;
  detail: string;
  code?: string;
};

export type PrinterInfo = {
  name: string;
  status: string;
};

export type ListPrintersResult = {
  printers: PrinterInfo[];
  default: string | null;
};

export type SaveReceiptResult = {
  ok: boolean;
  path: string;
};

const DEFAULTS: PosSettings = {
  paperKind: "letter",
  charsPerLine: null,
  printerPath: "",
  reviewUrl: "",
  receiptLegal: DEFAULT_LEGAL,
  terminalDeviceId: "",
  taxRateBps: 0,
};

type Memory = {
  units: CachedUnit[];
  outbox: OutboxRow[];
  incidents: { id: string; sku: string; message: string; createdAt: string }[];
  settings: PosSettings;
  pin: string;
  lastSavedReceipt: string | null;
};

const memory: Memory = {
  units: [],
  outbox: [],
  incidents: [],
  settings: { ...DEFAULTS },
  pin: "",
  lastSavedReceipt: null,
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(cmd, args);
  }
  return memoryInvoke<T>(cmd, args);
}

function memoryInvoke<T>(cmd: string, args: Record<string, unknown> = {}): T {
  switch (cmd) {
    case "cache_replace_units":
      memory.units = (args.units as CachedUnit[]).map(stripCost);
      return undefined as T;
    case "search_units": {
      const q = String(args.query || "")
        .trim()
        .toLowerCase();
      const rows = memory.units.filter((u) => u.state === "available");
      if (!q) return rows as T;
      return rows.filter((u) =>
        [u.sku, u.title, u.brand, u.model, u.category].some((v) => String(v || "").toLowerCase().includes(q)),
      ) as T;
    }
    case "outbox_insert":
      memory.outbox.push(args.row as OutboxRow);
      return undefined as T;
    case "outbox_pending":
      return memory.outbox.filter((r) => r.status === "pending") as T;
    case "outbox_update": {
      const row = memory.outbox.find((r) => r.id === args.id);
      if (row) {
        row.status = args.status as OutboxStatus;
        row.receiptNo = (args.receiptNo as string | null) ?? row.receiptNo;
        row.error = (args.error as string | null) ?? null;
      }
      return undefined as T;
    }
    case "incident_insert":
      memory.incidents.unshift({
        id: String(args.id),
        sku: String(args.sku),
        message: String(args.message),
        createdAt: new Date().toISOString(),
      });
      return undefined as T;
    case "incidents_list":
      return memory.incidents as T;
    case "settings_get":
      return { ...memory.settings } as T;
    case "settings_set":
      memory.settings = { ...memory.settings, ...(args.settings as Partial<PosSettings>) };
      return undefined as T;
    case "print_bytes":
      return {
        printed: false,
        code: "no_printer",
        detail: "no printer configured",
      } as T;
    case "list_printers":
      return { printers: [], default: null } as T;
    case "printer_paper_hint":
      return { hint: "letter" } as T;
    case "receipt_pdf":
      return Array.from(new TextEncoder().encode(String(args.text || ""))) as T;
    case "save_receipt_pdf": {
      const ts = Date.now();
      const path =
        (typeof args.path === "string" && args.path.trim()) || `/tmp/floor-receipt-${ts}.pdf`;
      memory.lastSavedReceipt = path;
      return { ok: true, path } as T;
    }
    case "open_external":
      return undefined as T;
    case "kiosk_power":
      return { ok: false, detail: "not a kiosk session" } as T;
    case "verify_admin_pin":
      return (memory.pin !== "" && memory.pin === String(args.pin || "")) as T;
    case "set_admin_pin":
      memory.pin = String(args.pin || "");
      return undefined as T;
    case "has_admin_pin":
      return (memory.pin !== "") as T;
    default:
      throw new Error(`unknown local command ${cmd}`);
  }
}

function stripCost(unit: CachedUnit): CachedUnit {
  const row = unit as CachedUnit & { acquisitionCostCents?: unknown; floorCents?: unknown };
  delete row.acquisitionCostCents;
  delete row.floorCents;
  return {
    sku: unit.sku,
    title: unit.title,
    brand: unit.brand,
    model: unit.model,
    category: unit.category,
    condition: unit.condition,
    askCents: unit.askCents,
    state: unit.state,
    qtyOnHand: unit.qtyOnHand ?? 1,
    photoUrl: unit.photoUrl ?? null,
  };
}

export async function cacheReplaceUnits(units: CachedUnit[]): Promise<void> {
  await invoke("cache_replace_units", { units: units.map(stripCost) });
}

export async function searchUnits(query: string): Promise<CachedUnit[]> {
  return invoke("search_units", { query });
}

export async function outboxInsert(row: OutboxRow): Promise<void> {
  await invoke("outbox_insert", { row });
}

export async function outboxPending(): Promise<OutboxRow[]> {
  return invoke("outbox_pending");
}

export async function outboxUpdate(
  id: string,
  status: OutboxStatus,
  receiptNo: string | null,
  error: string | null,
): Promise<void> {
  await invoke("outbox_update", { id, status, receiptNo, error });
}

export async function incidentInsert(id: string, sku: string, message: string): Promise<void> {
  await invoke("incident_insert", { id, sku, message });
}

export async function incidentsList(): Promise<{ id: string; sku: string; message: string; createdAt: string }[]> {
  return invoke("incidents_list");
}

export async function loadPosSettings(): Promise<PosSettings> {
  const stored = await invoke<Partial<PosSettings>>("settings_get");
  return { ...DEFAULTS, ...stored };
}

export async function savePosSettings(settings: PosSettings): Promise<void> {
  await invoke("settings_set", { settings });
}

export async function printBytes(data: Uint8Array, printerPath: string, raw = false): Promise<PrintResult> {
  return invoke("print_bytes", { data: Array.from(data), printerPath, raw });
}

/** Letter-size receipt as a real PDF (with review QR) for CUPS raster printers. */
export async function receiptPdfBytes(text: string, qrUrl?: string | null): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("receipt_pdf", { text, qrUrl: qrUrl ?? null });
  return new Uint8Array(bytes);
}

export async function printerPaperHint(name: string): Promise<PaperKind> {
  try {
    const res = await invoke<{ hint?: string }>("printer_paper_hint", { name });
    if (res.hint === "roll58" || res.hint === "roll80" || res.hint === "letter") return res.hint;
  } catch {
    /* not a CUPS printer */
  }
  return "letter";
}

export async function listPrinters(): Promise<ListPrintersResult> {
  return invoke("list_printers");
}

export async function saveReceiptPdf(
  text: string,
  path?: string | null,
  qrUrl?: string | null,
): Promise<SaveReceiptResult> {
  return invoke("save_receipt_pdf", { text, path: path ?? null, qrUrl: qrUrl ?? null });
}

/** Open an https URL in the desktop browser (allowlisted hosts only). */
export async function openExternal(url: string): Promise<void> {
  await invoke("open_external", { url });
}

export async function kioskPower(action: "poweroff" | "reboot"): Promise<{ ok: boolean; detail: string }> {
  return invoke("kiosk_power", { action });
}

export async function verifyAdminPin(pin: string): Promise<boolean> {
  return invoke("verify_admin_pin", { pin });
}

export async function setAdminPin(pin: string): Promise<void> {
  await invoke("set_admin_pin", { pin });
}

export async function hasAdminPin(): Promise<boolean> {
  return invoke("has_admin_pin");
}
