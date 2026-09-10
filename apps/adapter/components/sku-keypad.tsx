"use client";

import { useEffect, useRef } from "react";

type Props = {
  value: string;
  onChange: (next: string) => void;
  onEnter?: () => void;
  onClear?: () => void;
  maxLength?: number;
};

export function SkuKeypad({ value, onChange, onEnter, onClear, maxLength = 5 }: Props) {
  const hidden = useRef<HTMLInputElement>(null);

  useEffect(() => {
    hidden.current?.focus();
  }, []);

  function add(digit: string) {
    if (value.length >= maxLength) return;
    onChange(value + digit);
  }

  function backspace() {
    onChange(value.slice(0, -1));
  }

  function keys(e: { key: string; preventDefault: () => void }) {
    if (/^\d$/.test(e.key)) add(e.key);
    else if (e.key === "Backspace") backspace();
    else if (e.key === "Enter") onEnter?.();
    else if (e.key === "Escape") {
      onChange("");
      onClear?.();
    }
  }

  const keysGrid = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clr", "0", "go"];

  return (
    <div className="rounded-xl border border-floor-line bg-floor-panel p-3" data-floor-osk="off">
      <input
        ref={hidden}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, maxLength))}
        onKeyDown={keys}
        inputMode="numeric"
        autoComplete="off"
        aria-label="SKU"
        className="mb-3 w-full min-h-touch rounded-lg border border-floor-line bg-black px-3 text-center text-4xl font-black tracking-[0.4em] text-floor-accent"
      />
      <div className="grid grid-cols-3 gap-2">
        {keysGrid.map((key) => (
          <button
            key={key}
            type="button"
            className="min-h-14 rounded-lg bg-black text-2xl font-black text-floor-text"
            onClick={() => {
              if (key === "clr") {
                onChange("");
                onClear?.();
              } else if (key === "go") onEnter?.();
              else add(key);
            }}
          >
            {key === "clr" ? "Esc" : key === "go" ? "Enter" : key}
          </button>
        ))}
      </div>
    </div>
  );
}
