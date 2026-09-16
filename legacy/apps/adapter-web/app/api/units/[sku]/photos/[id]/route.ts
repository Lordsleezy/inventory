import { NextResponse } from "next/server";
import { isSku } from "@floor/domain";
import { readStockPhoto } from "@floor/inventree";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";

export async function GET(req: Request, ctx: { params: Promise<{ sku: string; id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { sku, id } = await ctx.params;
  if (!isSku(sku)) return NextResponse.json({ error: "SKU must be five digits" }, { status: 400 });
  const attachmentId = Number(id);
  if (!Number.isInteger(attachmentId)) return NextResponse.json({ error: "Bad photo" }, { status: 400 });
  const download = new URL(req.url).searchParams.get("download") === "1";
  try {
    const file = await readStockPhoto(inventreeClient(session), { sku, attachmentId });
    const safe = file.filename.replace(/"/g, "");
    return new NextResponse(Buffer.from(file.bytes), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safe}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
  }
}
