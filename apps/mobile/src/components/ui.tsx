import { useEffect, useRef, useState } from "react";
import { centsToInput, parseMoneyToCents } from "@floor/store";

export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`border-b border-floor-line py-3 ${className}`}>{children}</div>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-quiet tracking-wide text-floor-mute">{children}</span>;
}

export function Notice({ tone, children }: { tone: "error" | "ok"; children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className={`py-2 text-quiet ${tone === "error" ? "text-floor-danger" : "text-floor-ok"}`}>
      {children}
    </p>
  );
}

/** A text field that commits on blur and reports only real changes. */
export function TextField({
  label,
  value,
  onCommit,
  placeholder,
  multiline,
  inputMode,
  disabled,
}: {
  label: string;
  value: string | null;
  onCommit: (next: string | null) => Promise<void> | void;
  placeholder?: string;
  multiline?: boolean;
  inputMode?: "text" | "numeric" | "tel" | "email";
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const committed = useRef(value ?? "");

  useEffect(() => {
    setDraft(value ?? "");
    committed.current = value ?? "";
  }, [value]);

  async function commit() {
    const trimmed = draft.trim();
    if (trimmed === committed.current.trim()) return;
    committed.current = trimmed;
    await onCommit(trimmed === "" ? null : trimmed);
  }

  const Tag = multiline ? "textarea" : "input";
  return (
    <label className="block py-2">
      <Label>{label}</Label>
      <Tag
        className="field mt-1"
        value={draft}
        placeholder={placeholder}
        inputMode={inputMode}
        disabled={disabled}
        rows={multiline ? 3 : undefined}
        onChange={(e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) =>
          setDraft(e.target.value)
        }
        onBlur={() => void commit()}
      />
    </label>
  );
}

/**
 * Money field. An empty box means unpriced, and stays unpriced — it is never
 * quietly turned into zero.
 */
export function MoneyField({
  label,
  cents,
  onCommit,
  disabled,
}: {
  label: string;
  cents: number | null;
  onCommit: (next: number | null) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(centsToInput(cents));
  const [bad, setBad] = useState(false);
  const committed = useRef(centsToInput(cents));

  useEffect(() => {
    setDraft(centsToInput(cents));
    committed.current = centsToInput(cents);
    setBad(false);
  }, [cents]);

  async function commit() {
    if (draft.trim() === committed.current.trim()) return;
    const parsed = parseMoneyToCents(draft);
    if (parsed === undefined) {
      setBad(true);
      return;
    }
    setBad(false);
    committed.current = draft.trim();
    await onCommit(parsed);
  }

  return (
    <label className="block py-2">
      <Label>{label}</Label>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={draft.trim() === "" ? "text-floor-line" : "text-floor-mute"}>$</span>
        <input
          className="field"
          value={draft}
          inputMode="decimal"
          placeholder="—"
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
        />
      </div>
      {bad ? <span className="text-quiet text-floor-danger">Enter an amount like 19.99</span> : null}
    </label>
  );
}

/** Dropdown over a user-configurable list. Always allows "not set". */
export function SelectField({
  label,
  value,
  options,
  onCommit,
  disabled,
}: {
  label: string;
  value: string | null;
  options: string[];
  onCommit: (next: string | null) => Promise<void> | void;
  disabled?: boolean;
}) {
  // A value set before the list was edited must still be selectable.
  const choices = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <label className="block py-2">
      <Label>{label}</Label>
      <select
        className="field mt-1"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => void onCommit(e.target.value === "" ? null : e.target.value)}
      >
        <option value="">—</option>
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Two-step destructive action, so nothing irreversible is one tap away. */
export function DangerButton({
  idle,
  confirm,
  onConfirm,
  disabled,
}: {
  idle: string;
  confirm: string;
  onConfirm: () => Promise<void> | void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!armed) {
    return (
      <button type="button" className="btn-text px-0 text-floor-danger" disabled={disabled} onClick={() => setArmed(true)}>
        {idle}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-3">
      <button
        type="button"
        className="min-h-touch bg-floor-danger px-3 text-body font-medium text-black"
        disabled={disabled}
        onClick={() => void onConfirm()}
      >
        {confirm}
      </button>
      <button type="button" className="btn-text px-0" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}

export function Spinner({ label = "Working" }: { label?: string }) {
  return <p className="py-3 text-quiet text-floor-mute">{label}…</p>;
}
