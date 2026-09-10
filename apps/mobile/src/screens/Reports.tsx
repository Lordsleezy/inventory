import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatCentsTotal, reports, type Reports } from "@floor/store";
import { useDb } from "../store";
import { Label, Notice, Spinner } from "../components/ui";

export function ReportsScreen() {
  const db = useDb();
  const [data, setData] = useState<Reports | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void reports(db)
      .then((out) => live && setData(out))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [db]);

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

      <div className="mt-8">
        <Label>Aging</Label>
        <ul className="mt-2">
          {data.agingBuckets.map((bucket) => (
            <li key={bucket.label} className="flex items-center gap-3 border-b border-floor-line py-2">
              <span className="w-24 shrink-0 text-quiet text-floor-mute">{bucket.label}</span>
              <span className="min-w-0 flex-1">
                <span
                  className="block h-1 bg-floor-accent"
                  style={{
                    width: `${data.inStock ? Math.round((bucket.count / data.inStock) * 100) : 0}%`,
                  }}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-body">{bucket.count}</span>
            </li>
          ))}
        </ul>
      </div>

        <p className="mt-6 text-quiet text-floor-mute">
          Money tied up counts only units still in stock, and only what you recorded paying. Units
          with no cost entered contribute nothing.
        </p>

      <Link to="/backup" className="btn-text mt-4 px-0">
        Export and back up
      </Link>
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
