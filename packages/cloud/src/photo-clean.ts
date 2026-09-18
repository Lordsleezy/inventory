/** Inspect a cutout (RGBA) and decide reshoot vs optional dirt cleanup. */

export type CutoutFlags = {
  coverage: number;
  centerCoverage: number;
  subjectMeanLuma: number;
  centerMeanLuma: number;
  stainFraction: number;
  reshoot: string[];
  exterior: boolean;
  looksDirty: boolean;
};

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function sat(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export function inspectCutout(rgba: Uint8Array, width: number, height: number): CutoutFlags {
  const n = width * height;
  const x0 = Math.floor(width * 0.3);
  const x1 = Math.ceil(width * 0.7);
  const y0 = Math.floor(height * 0.3);
  const y1 = Math.ceil(height * 0.7);
  let opaque = 0;
  let center = 0;
  let centerOpaque = 0;
  let subL = 0;
  let subS = 0;
  let centerL = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3] ?? 0;
      const inCenter = x >= x0 && x < x1 && y >= y0 && y < y1;
      if (inCenter) center += 1;
      if (a < 32) continue;
      opaque += 1;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      const L = luma(r, g, b);
      subL += L;
      subS += sat(r, g, b);
      if (inCenter) {
        centerOpaque += 1;
        centerL += L;
      }
    }
  }

  const coverage = n ? opaque / n : 0;
  const centerCoverage = center ? centerOpaque / center : 0;
  const subjectMeanLuma = opaque ? subL / opaque : 0;
  const centerMeanLuma = centerOpaque ? centerL / centerOpaque : 0;
  const subjectSat = opaque ? subS / opaque : 0;
  const stainFraction = stainScore(rgba, width, height);

  const reshoot: string[] = [];
  if (coverage < 0.12) reshoot.push("too little subject");
  if (coverage > 0.92) reshoot.push("failed cutout");
  const ring = coverage > 0.2 && centerCoverage < 0.35;
  const darkCavity = centerCoverage > 0.2 && centerMeanLuma + 28 < subjectMeanLuma && centerMeanLuma < 55;
  if (ring || darkCavity) reshoot.push("interior");
  if (subjectMeanLuma < 42 && subjectSat < 0.18 && coverage > 0.15) reshoot.push("dark glass");

  const exterior = !reshoot.includes("interior") && !reshoot.includes("failed cutout") && !reshoot.includes("too little subject");
  const looksDirty = exterior && stainFraction >= 0.015;

  return {
    coverage,
    centerCoverage,
    subjectMeanLuma,
    centerMeanLuma,
    stainFraction,
    reshoot,
    exterior,
    looksDirty,
  };
}

/** Dirt speckles: darker than a local neighborhood, not a strong edge. */
export function stainScore(rgba: Uint8Array, width: number, height: number): number {
  let subject = 0;
  let stains = 0;
  const step = 3;
  for (let y = 4; y < height - 4; y += step) {
    for (let x = 4; x < width - 4; x += step) {
      const i = (y * width + x) * 4;
      if ((rgba[i + 3] ?? 0) < 64) continue;
      subject += 1;
      const L = luma(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
      let sum = 0;
      let c = 0;
      for (let dy = -4; dy <= 4; dy += 2) {
        for (let dx = -4; dx <= 4; dx += 2) {
          const j = ((y + dy) * width + (x + dx)) * 4;
          if ((rgba[j + 3] ?? 0) < 64) continue;
          sum += luma(rgba[j] ?? 0, rgba[j + 1] ?? 0, rgba[j + 2] ?? 0);
          c += 1;
        }
      }
      if (c < 6) continue;
      const local = sum / c;
      const gx = Math.abs((rgba[i + 4] ?? 0) - (rgba[i - 4] ?? 0));
      const gy = Math.abs((rgba[i + width * 4] ?? 0) - (rgba[i - width * 4] ?? 0));
      const edge = gx + gy > 80;
      if (!edge && local - L > 22 && L < 170) stains += 1;
    }
  }
  return subject ? stains / subject : 0;
}

export function dirtMaskPngPrep(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const step = 1;
  for (let y = 3; y < height - 3; y += step) {
    for (let x = 3; x < width - 3; x += step) {
      const i = (y * width + x) * 4;
      if ((rgba[i + 3] ?? 0) < 64) continue;
      const L = luma(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
      let sum = 0;
      let c = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const j = ((y + dy) * width + (x + dx)) * 4;
          if ((rgba[j + 3] ?? 0) < 64) continue;
          sum += luma(rgba[j] ?? 0, rgba[j + 1] ?? 0, rgba[j + 2] ?? 0);
          c += 1;
        }
      }
      if (c < 8) continue;
      if (sum / c - L > 20 && L < 175) mask[y * width + x] = 255;
    }
  }
  // Dilate ~2px so Clipdrop has a slightly larger mask.
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let dy = -2; dy <= 2 && !on; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          if (mask[yy * width + xx]) {
            on = 1;
            break;
          }
        }
      }
      const p = (y * width + x) * 4;
      const v = on ? 255 : 0;
      out[p] = v;
      out[p + 1] = v;
      out[p + 2] = v;
      out[p + 3] = 255;
    }
  }
  return out;
}

export function whiteBalanceRgba(rgba: Uint8Array): Uint8Array {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < 64) continue;
    r += rgba[i] ?? 0;
    g += rgba[i + 1] ?? 0;
    b += rgba[i + 2] ?? 0;
    n += 1;
  }
  if (n < 10) return rgba;
  const mr = r / n;
  const mg = g / n;
  const mb = b / n;
  const gray = (mr + mg + mb) / 3;
  const sr = gray / (mr || 1);
  const sg = gray / (mg || 1);
  const sb = gray / (mb || 1);
  const out = new Uint8Array(rgba);
  for (let i = 0; i < out.length; i += 4) {
    if ((out[i + 3] ?? 0) < 16) continue;
    out[i] = Math.min(255, Math.round((out[i] ?? 0) * sr));
    out[i + 1] = Math.min(255, Math.round((out[i + 1] ?? 0) * sg));
    out[i + 2] = Math.min(255, Math.round((out[i + 2] ?? 0) * sb));
  }
  return out;
}

export function brightnessGain(meanLuma: number): number {
  if (meanLuma <= 0) return 1;
  return Math.min(1.28, Math.max(0.88, 132 / meanLuma));
}

export function parseOnlyFlag(argv: string[]): string[] {
  const skus: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--only") continue;
    const raw = argv[i + 1] ?? "";
    for (const part of raw.split(",")) {
      const sku = part.trim();
      if (sku) skus.push(sku);
    }
  }
  return skus;
}

export function skuAllowed(sku: string, only: string[]): boolean {
  if (!only.length) return true;
  return only.some((s) => s === sku || sku.startsWith(s));
}

export function folderMatchesSku(folder: string, only: string[]): boolean {
  if (!only.length) return true;
  return only.some((s) => folder === s || folder.startsWith(`${s}-`));
}

export const CLIPDROP_CLEANUP_COST = {
  provider: "Clipdrop Cleanup API (clipdrop-api.co/cleanup/v1)",
  meter: "1 successful call = 1 credit",
  usd: "Clipdrop/Jasper sells credits in packs (no fixed public USD on the docs page as of 2026). New keys get 100 free credits. Recent packs have been about $0.02–$0.05 per credit ($0.02–$0.05 per image).",
  exactUsdIfUsingPhotoroomPlusInstead: 0.1,
};

export type PhotoChoice = "pending" | "original" | "clean" | "generative";

export type ReviewDecision = {
  reshoot: string[];
  hasClean: boolean;
  hasGenerative: boolean;
  choice: PhotoChoice;
};

export function approveAllClean(items: ReviewDecision[]): ReviewDecision[] {
  return items.map((item) => {
    if (item.reshoot.length) return item;
    if (item.hasGenerative) return item;
    if (!item.hasClean) return item;
    return { ...item, choice: "clean" };
  });
}

export function uploadAction(item: ReviewDecision): {
  action: "skip" | "replace";
  reason?: string;
  source?: "clean" | "generative";
} {
  if (item.reshoot.length) return { action: "skip", reason: `needs reshoot: ${item.reshoot.join(", ")}` };
  if (item.choice === "pending") return { action: "skip", reason: "not approved" };
  if (item.choice === "original") return { action: "skip", reason: "keep original" };
  if (item.choice === "clean") {
    if (!item.hasClean) return { action: "skip", reason: "no clean file" };
    return { action: "replace", source: "clean" };
  }
  if (item.choice === "generative") {
    if (!item.hasGenerative) return { action: "skip", reason: "no generative file" };
    return { action: "replace", source: "generative" };
  }
  return { action: "skip", reason: "not approved" };
}

/** Live keys stay {store}/{sku}/file. Archive is {store}/archive/{sku}/file so anon RLS cannot read it. */
export function archiveStoragePath(livePath: string): string {
  const parts = livePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length >= 3 && parts[1] !== "archive") {
    return `${parts[0]}/archive/${parts[1]}/${parts.slice(2).join("/")}`;
  }
  return `archive/${livePath}`;
}

/** New object name under the same {store}/{sku}/ prefix so CDNs and the website cannot keep a stale JPEG. */
export function nextVersionedFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() || "photo.jpg";
  const bump = base.match(/^(.*)-v(\d+)(\.[^.]+)$/i);
  if (bump) return `${bump[1]}-v${Number(bump[2]) + 1}${bump[3]}`;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return `${base}-v2`;
  return `${base.slice(0, dot)}-v2${base.slice(dot)}`;
}

export function nextVersionedStoragePath(livePath: string): string {
  const parts = livePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 3) {
    throw new Error("Photo storage keys are {store_id}/{sku}/{filename}.");
  }
  parts[parts.length - 1] = nextVersionedFilename(parts[parts.length - 1] ?? "photo.jpg");
  return parts.join("/");
}

export type ManifestPhoto = { folder: string; file: string };

/** Match Desktop/floor-photos-clean files to the export manifest. Extra or renamed files are not uploaded. */
export function planCleanImport(
  manifest: ManifestPhoto[],
  cleanRelPaths: string[],
): { toUpload: ManifestPhoto[]; missing: string[]; extra: string[] } {
  const wanted = new Map<string, ManifestPhoto>();
  for (const row of manifest) {
    wanted.set(`${row.folder}/${row.file}`.replace(/\\/g, "/"), row);
  }
  const clean = new Set(cleanRelPaths.map((p) => p.replace(/\\/g, "/")));
  const toUpload: ManifestPhoto[] = [];
  const missing: string[] = [];
  for (const [key, row] of wanted) {
    if (clean.has(key)) toUpload.push(row);
    else missing.push(key);
  }
  const extra: string[] = [];
  for (const key of clean) {
    if (!wanted.has(key)) extra.push(key);
  }
  extra.sort();
  missing.sort();
  return { toUpload, missing, extra };
}

