import { useEffect, useState } from "react";
import { formatCentsTotal } from "@floor/store";
import { floorCloud } from "@floor/cloud";
import { useStore } from "../store";
import { Label, Notice, Spinner } from "../components/ui";

type Totals = {
  inStock: number;
  soldThisWeek: number;
  moneyTiedUpCents: number;
  askValueCents: number;
  soldThisWeekCents: number;
};

export function ReportsScreen() {
  const { session } = useStore();
  const [data, setData] = useState<Totals | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (session.role === "staff") return;
    let live = true;
    void (async () => {
      const units = await floorCloud().from("units").select("state, acquisition_cost_cents, ask_cents");
      const sales = await floorCloud()
        .from("sales")
        .select("price_cents, sold_at, voided_at")
        .is("voided_at", null);
      if (units.error) throw units.error;
      if (sales.error) throw sales.error;
      const week = Date.now() - 7 * 24 * 3600 * 1000;
      const stock = (units.data ?? []).filter((u) => ["available", "reserved", "repair"].includes(u.state));
      const weekSales = (sales.data ?? []).filter((s) => new Date(s.sold_at).getTime() >= week);
      const totals: Totals = {
        inStock: stock.length,
        soldThisWeek: weekSales.length,
        moneyTiedUpCents: stock.reduce((n, u) => n + (u.acquisition_cost_cents ?? 0), 0),
        askValueCents: stock.reduce((n, u) => n + (u.ask_cents ?? 0), 0),
        soldThisWeekCents: weekSales.reduce((n, s) => n + (s.price_cents ?? 0), 0),
      };
      if (live) setData(totals);
    })().catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [session.role]);

  if (session.role === "staff") {
    return <p className="text-quiet">Reports are for managers and owners.</p>;
  }
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Spinner label="Counting" />;

  return (
    <section>
      <h1 className="text-title">Reports</h1>
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5">
        <Stat label="Units in stock" value={String(data.inStock)} />
        <Stat label="Sold this week" value={String(data.soldThisWeek)} />
        <Stat label="Money tied up" value={formatCentsTotal(data.moneyTiedUpCents)} hint="what you paid" />
        <Stat label="Asking value" value={formatCentsTotal(data.askValueCents)} hint="priced units only" />
        <Stat label="Took this week" value={formatCentsTotal(data.soldThisWeekCents)} />
      </div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <p className="text-title">{value}</p>
      {hint ? <p className="text-quiet text-floor-mute">{hint}</p> : null}
    </div>
  );
}
