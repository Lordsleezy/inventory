import { NextResponse } from "next/server";
import { assertInspectFields, isSku, moneyStringToCents } from "@floor/domain";
import { inspectUnit, loadUnitBySku, priceUnit, retagSku, setListing, updatePartFields } from "@floor/inventree";
import { inventreeClient } from "@/lib/inventree";
import { getSession } from "@/lib/session";
import { redactUnit } from "@/lib/redact";
import { loadFloorConfig } from "@/lib/config";
import { assertSkuAvailable, recordFate, recordIssued } from "@/lib/sku-ledger";

function fail(err: unknown) {
  const status = (err as { status?: number }).status ?? 500;
  return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status });
}

export async function GET(_req: Request, ctx: { params: Promise<{ sku: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { sku } = await ctx.params;
  if (!isSku(sku)) {
    return NextResponse.json({ error: "SKU must be five digits", unit: null }, { status: 400 });
  }
  const unit = await loadUnitBySku(inventreeClient(session), sku);
  if (!unit) return NextResponse.json({ error: "No item with that SKU", unit: null }, { status: 404 });
  return NextResponse.json({ unit: redactUnit(unit, session.role) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ sku: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const { sku } = await ctx.params;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const client = inventreeClient(session);
    if (body.op === "inspect") {
      const condition = body.condition == null || body.condition === "" ? null : String(body.condition);
      const testStatus = String(body.testStatus ?? "untested");
      assertInspectFields(loadFloorConfig(), { condition, testStatus });
      const unit = await inspectUnit(client, {
        sku,
        condition,
        testStatus,
        defectNotes: body.defectNotes ? String(body.defectNotes) : null,
        mfrSerial: body.mfrSerial ? String(body.mfrSerial) : null,
        location: body.location ? String(body.location) : null,
        actor: session.displayName,
      });
      return NextResponse.json({ unit: redactUnit(unit, session.role) });
    }
    if (body.op === "part") {
      const unit = await updatePartFields(client, {
        sku,
        brand: String(body.brand ?? ""),
        model: String(body.model ?? ""),
        title: String(body.title ?? ""),
        category: String(body.category ?? ""),
        upc: String(body.upc ?? ""),
        actor: session.displayName,
      });
      return NextResponse.json({ unit: redactUnit(unit, session.role) });
    }
    if (body.op === "sku") {
      const nextSku = String(body.nextSku ?? "").trim();
      if (!isSku(nextSku)) {
        return NextResponse.json({ error: "SKU must be five digits" }, { status: 400 });
      }
      if (nextSku !== sku) await assertSkuAvailable(client, nextSku);
      const current = await loadUnitBySku(client, sku);
      if (!current) return NextResponse.json({ error: "No item with that SKU" }, { status: 404 });
      const unit = await retagSku(client, { sku, nextSku, actor: session.displayName });
      if (nextSku !== sku) {
        recordFate(current, "retired");
        recordIssued(unit);
      }
      return NextResponse.json({ unit: redactUnit(unit, session.role) });
    }
    if (body.op === "listing") {
      const state = String(body.state ?? "");
      if (state !== "NOT_LISTED" && state !== "LISTED" && state !== "ENDED") {
        return NextResponse.json({ error: "Listing state must be NOT_LISTED, LISTED, or ENDED" }, { status: 400 });
      }
      const unit = await setListing(client, {
        sku,
        channel: String(body.channel ?? ""),
        state,
        url: body.url ? String(body.url) : null,
        actor: session.displayName,
      });
      return NextResponse.json({ unit: redactUnit(unit, session.role) });
    }
    if (body.op === "price") {
      const unit = await priceUnit(client, {
        sku,
        msrpCents: moneyStringToCents((body.msrp as string) ?? ""),
        retailCents: moneyStringToCents((body.retail as string) ?? ""),
        retailer: body.retailer ? String(body.retailer) : null,
        capturedOn: body.capturedOn ? String(body.capturedOn) : null,
        askCents: moneyStringToCents((body.ask as string) ?? ""),
        floorCents: moneyStringToCents((body.floor as string) ?? ""),
        actor: session.displayName,
        role: session.role,
      });
      return NextResponse.json({ unit: redactUnit(unit, session.role) });
    }
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (err) {
    return fail(err);
  }
}
