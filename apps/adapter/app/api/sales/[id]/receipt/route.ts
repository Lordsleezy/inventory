import { NextResponse } from "next/server";
import {
  parseReceiptUpload,
  publicReceiptFile,
  receiptContentDisposition,
  receiptUploadError,
  storedReceiptName,
} from "@floor/domain";
import { clearSaleReceiptFile, loadSale, loadSaleReceiptFile, setSaleReceiptFile } from "@floor/inventree";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";
import { loadFloorConfig } from "@/lib/config";
import { deleteSaleReceiptBytes, readSaleReceiptBytes, writeSaleReceiptBytes } from "@/lib/receipt-store";

function fail(err: unknown) {
  const status = (err as { status?: number }).status ?? 500;
  return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
}

async function soIdFrom(ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const soId = Number(id);
  if (!Number.isInteger(soId) || soId < 1) return null;
  return soId;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const soId = await soIdFrom(ctx);
  if (soId === null) return NextResponse.json({ error: "Bad sale" }, { status: 400 });
  const download = new URL(req.url).searchParams.get("download") === "1";
  try {
    const record = await loadSaleReceiptFile(inventreeClient(session), soId, loadFloorConfig().taxRateBps);
    if (!record) return NextResponse.json({ error: "No receipt uploaded" }, { status: 404 });
    const bytes = readSaleReceiptBytes(soId, record.storedName);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": record.contentType,
        "Content-Disposition": receiptContentDisposition(record.filename, download),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const soId = await soIdFrom(ctx);
  if (soId === null) return NextResponse.json({ error: "Bad sale" }, { status: 400 });
  const taxRateBps = loadFloorConfig().taxRateBps;
  const client = inventreeClient(session);
  try {
    await loadSale(client, soId, taxRateBps);
    const form = await req.formData();
    const file = form.get("receipt");
    if (!(file instanceof File)) return NextResponse.json({ error: "Pick a receipt" }, { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const blocked = receiptUploadError({ filename: file.name || "receipt", byteLength: bytes.byteLength });
    if (blocked) return NextResponse.json({ error: blocked }, { status: 400 });
    const parsed = parseReceiptUpload(file.name || "receipt");
    const storedName = storedReceiptName(file.name || "receipt");
    if (!parsed || !storedName) return NextResponse.json({ error: "Use a PDF, JPEG, PNG, WebP, or HEIC" }, { status: 400 });
    const next = {
      filename: parsed.originalName,
      storedName,
      contentType: parsed.contentType,
      uploadedAt: new Date().toISOString(),
    };
    writeSaleReceiptBytes(soId, storedName, bytes);
    let previous = null;
    try {
      previous = await setSaleReceiptFile(client, {
        soId,
        taxRateBps,
        file: next,
        actor: session.displayName,
      });
    } catch (err) {
      deleteSaleReceiptBytes(soId, storedName);
      throw err;
    }
    if (previous && previous.storedName !== storedName) deleteSaleReceiptBytes(soId, previous.storedName);
    return NextResponse.json({ receiptFile: publicReceiptFile(next) });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const soId = await soIdFrom(ctx);
  if (soId === null) return NextResponse.json({ error: "Bad sale" }, { status: 400 });
  try {
    const previous = await clearSaleReceiptFile(inventreeClient(session), {
      soId,
      taxRateBps: loadFloorConfig().taxRateBps,
      actor: session.displayName,
    });
    if (previous) deleteSaleReceiptBytes(soId, previous.storedName);
    return NextResponse.json({ receiptFile: null });
  } catch (err) {
    return fail(err);
  }
}
