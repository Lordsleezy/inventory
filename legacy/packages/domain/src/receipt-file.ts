export const RECEIPT_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
};

export type SaleReceiptFile = {
  filename: string;
  contentType: string;
  uploadedAt: string;
};

export type SaleReceiptFileRecord = SaleReceiptFile & {
  storedName: string;
};

export function parseReceiptUpload(filename: string): { ext: string; contentType: string; originalName: string } | null {
  if (filename.includes("\0") || filename.includes("..")) return null;
  const originalName = (filename.split(/[/\\]/).pop() ?? "").trim();
  if (!originalName || originalName === "." || originalName === "..") return null;
  const match = originalName.match(/\.([a-zA-Z0-9]+)$/);
  if (!match) return null;
  const rawExt = match[1].toLowerCase();
  const contentType = CONTENT_TYPES[rawExt];
  if (!contentType) return null;
  const ext = rawExt === "jpeg" ? "jpg" : rawExt;
  return { ext, contentType, originalName };
}

export function storedReceiptName(originalName: string, now = Date.now()): string | null {
  const parsed = parseReceiptUpload(originalName);
  if (!parsed) return null;
  return `receipt-${now}.${parsed.ext}`;
}

export function isSafeStoredReceiptName(name: string): boolean {
  return /^receipt-\d+\.(pdf|jpg|png|webp|gif|heic|heif)$/.test(name);
}

export function receiptUploadError(input: { filename: string; byteLength: number }): string | null {
  if (input.byteLength < 1) return "Pick a receipt";
  if (input.byteLength > RECEIPT_UPLOAD_MAX_BYTES) return "Receipt is too large (15 MB max)";
  if (!parseReceiptUpload(input.filename)) return "Use a PDF, JPEG, PNG, WebP, or HEIC";
  return null;
}

export function publicReceiptFile(record: SaleReceiptFileRecord | null): SaleReceiptFile | null {
  if (!record) return null;
  return {
    filename: record.filename,
    contentType: record.contentType,
    uploadedAt: record.uploadedAt,
  };
}

export function parseReceiptFileRecord(raw: unknown): SaleReceiptFileRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.storedName !== "string" || !isSafeStoredReceiptName(row.storedName)) return null;
  if (typeof row.filename !== "string" || !parseReceiptUpload(row.filename)) return null;
  if (typeof row.contentType !== "string" || !row.contentType) return null;
  if (typeof row.uploadedAt !== "string" || !row.uploadedAt) return null;
  return {
    filename: row.filename,
    storedName: row.storedName,
    contentType: row.contentType,
    uploadedAt: row.uploadedAt,
  };
}

export function receiptContentDisposition(filename: string, download: boolean): string {
  const safe = filename.replace(/["\\\r\n]/g, "_");
  return `${download ? "attachment" : "inline"}; filename="${safe}"`;
}
