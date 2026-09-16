"use client";

import { useEffect, useState } from "react";

type Props = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  adminOnly?: boolean;
};

/** Dollars in, empty stays empty. Never forces 0.00. */
export function MoneyField({ label, value, onChange, adminOnly }: Props) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-floor-mute">
        {label}
        {adminOnly ? " (admin)" : ""}
      </span>
      <span className="flex items-center gap-1">
        <span className="text-floor-mute">$</span>
        <input
          inputMode="decimal"
          value={text}
          placeholder=""
          onChange={(e) => {
            const next = e.target.value.replace(/[^0-9.]/g, "");
            setText(next);
            onChange(next);
          }}
          className="field tabular-nums"
        />
      </span>
    </label>
  );
}
