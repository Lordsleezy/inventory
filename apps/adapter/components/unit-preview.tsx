import type { Unit } from "@floor/domain";
import { EmptyValue, Money } from "./empty-value";

export function UnitPreview({ unit, missing }: { unit: Unit | null; missing: boolean }) {
  if (missing) {
    return (
      <div className="rounded-xl border-2 border-floor-danger bg-floor-danger/10 p-4 text-center">
        <p className="text-2xl font-black text-floor-danger">No item with that SKU</p>
      </div>
    );
  }
  if (!unit) {
    return (
      <div className="rounded-xl border border-floor-line bg-floor-panel p-4 text-floor-mute">
        Type five digits to confirm the item
      </div>
    );
  }
  return (
    <div className="rounded-xl border-2 border-floor-accent bg-floor-panel p-4">
      <p className="text-4xl font-black tracking-widest text-floor-accent">{unit.sku}</p>
      <p className="mt-1 text-xl font-bold">
        <EmptyValue>{[unit.brand, unit.model].filter(Boolean).join(" ")}</EmptyValue>
      </p>
      <p className="text-floor-mute">
        <EmptyValue>{unit.condition}</EmptyValue>
        {unit.condition ? " · " : ""}
        <EmptyValue>{unit.location}</EmptyValue>
      </p>
      <p className="mt-2 text-2xl">
        <Money cents={unit.askCents} />
      </p>
      {unit.recordError ? <p className="mt-2 text-floor-danger">{unit.recordError}</p> : null}
    </div>
  );
}
