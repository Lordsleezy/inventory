import { NextResponse } from "next/server";
import { isSku } from "@floor/domain";
import {
  deleteStockPhoto,
  listUnitPhotos,
  reorderStockPhotos,
  setPrimaryPhoto,
  uploadStockPhoto,
} from "@floor/inventree";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";
import { redactUnit } from "@/lib/redact";

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 10;

function fail(err: unknown) {
  const status = (err as { status?: number }).status ?? 500;
  return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
}

export async function GET(_req: Request, ctx: { params: Promise<{ sku: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { sku } = await ctx.params;
  if (!isSku(sku)) return NextResponse.json({ error: "SKU must be five digits" }, { status: 400 });
  try {
    const { unit, photos } = await listUnitPhotos(inventreeClient(session), sku);
    return NextResponse.json({ unit: redactUnit(unit, session.role), photos });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ sku: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { sku } = await ctx.params;
  if (!isSku(sku)) return NextResponse.json({ error: "SKU must be five digits" }, { status: 400 });
  const client = inventreeClient(session);
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const files = form.getAll("photos").filter((row): row is File => row instanceof File);
      if (files.length === 0) return NextResponse.json({ error: "Pick a photo" }, { status: 400 });
      if (files.length > MAX_FILES) {
        return NextResponse.json({ error: `Attach at most ${MAX_FILES} photos at a time` }, { status: 400 });
      }
      let unit = null;
      for (const file of files) {
        if (file.size > MAX_BYTES) {
          return NextResponse.json({ error: `${file.name} is too large (15 MB max)` }, { status: 400 });
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        unit = await uploadStockPhoto(client, {
          sku,
          originalName: file.name || "photo.jpg",
          bytes,
          actor: session.displayName,
        });
      }
      const listed = await listUnitPhotos(client, sku);
      return NextResponse.json({
        unit: unit ? redactUnit(unit, session.role) : redactUnit(listed.unit, session.role),
        photos: listed.photos,
      });
    }
    const body = (await req.json()) as { attachmentId?: number };
    const unit = await setPrimaryPhoto(client, {
      sku,
      attachmentId: Number(body.attachmentId),
    });
    const listed = await listUnitPhotos(client, sku);
    return NextResponse.json({ unit: unit ? redactUnit(unit, session.role) : null, photos: listed.photos });
  } catch (err) {
    return fail(err);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ sku: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { sku } = await ctx.params;
  try {
    const body = (await req.json()) as { order?: number[] };
    const listed = await reorderStockPhotos(inventreeClient(session), {
      sku,
      order: Array.isArray(body.order) ? body.order.map(Number) : [],
    });
    return NextResponse.json({
      unit: redactUnit(listed.unit, session.role),
      photos: listed.photos,
    });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ sku: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { sku } = await ctx.params;
  try {
    const body = (await req.json()) as { attachmentId?: number };
    const listed = await deleteStockPhoto(inventreeClient(session), {
      sku,
      attachmentId: Number(body.attachmentId),
      actor: session.displayName,
    });
    return NextResponse.json({
      unit: redactUnit(listed.unit, session.role),
      photos: listed.photos,
    });
  } catch (err) {
    return fail(err);
  }
}
