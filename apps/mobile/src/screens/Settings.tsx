import { useState } from "react";
import { Link } from "react-router-dom";
import { type Settings } from "@floor/store";
import { useStore } from "../store";
import { Label, Notice } from "../components/ui";

const LISTS: { key: keyof Settings; label: string; hint: string }[] = [
  { key: "categories", label: "Categories", hint: "Appliances, power tools, whatever you sell" },
  { key: "conditions", label: "Conditions", hint: "How you grade a unit" },
  { key: "testStatuses", label: "Test statuses", hint: "Whether it has been checked" },
  { key: "locations", label: "Locations", hint: "Where a unit physically is" },
  { key: "channels", label: "Channels", hint: "Where a sale happened" },
  { key: "paymentMethods", label: "Payment methods", hint: "How you got paid" },
];

export function SettingsScreen() {
  const { settings, setSetting } = useStore();
  const [error, setError] = useState("");

  return (
    <section>
      <h1 className="text-title">Setup</h1>
      <p className="mt-1 text-quiet text-floor-mute">
        Every list below is yours. Nothing in Floor assumes what you sell.
      </p>

      <Notice tone="error">{error}</Notice>

      <label className="block py-3">
        <Label>Business name (prints on receipts)</Label>
        <input
          className="field mt-1"
          defaultValue={settings.storeName}
          onBlur={(e) => void setSetting("storeName", e.target.value.trim() || "Floor")}
        />
      </label>

      <label className="block py-3">
        <Label>Sales tax percent</Label>
        <input
          className="field mt-1"
          defaultValue={(settings.taxRateBps / 100).toString()}
          inputMode="decimal"
          onBlur={(e) => {
            const percent = Number(e.target.value);
            if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
              setError("Tax percent should be a number between 0 and 100.");
              return;
            }
            setError("");
            void setSetting("taxRateBps", Math.round(percent * 100));
          }}
        />
      </label>

      {LISTS.map((list) => (
        <ListEditor
          key={String(list.key)}
          label={list.label}
          hint={list.hint}
          values={settings[list.key] as string[]}
          onChange={(next) => setSetting(list.key, next)}
        />
      ))}

      <div className="mt-8 border-t border-floor-line pt-4">
        <Link to="/backup" className="btn-accent">
          Export and back up
        </Link>
        <p className="mt-3 text-quiet text-floor-mute">
          Everything lives on this phone. Back it up somewhere else regularly.
        </p>
      </div>
    </section>
  );
}

/**
 * Edit a vocabulary list. Removing an entry only stops it being offered on new
 * records — units that already use it keep their value, and it still shows on
 * their dropdown, so history never silently changes.
 */
function ListEditor({
  label,
  hint,
  values,
  onChange,
}: {
  label: string;
  hint: string;
  values: string[];
  onChange: (next: string[]) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");

  async function add() {
    const value = draft.trim();
    if (!value || values.includes(value)) {
      setDraft("");
      return;
    }
    setDraft("");
    await onChange([...values, value]);
  }

  return (
    <div className="border-b border-floor-line py-3">
      <Label>{label}</Label>
      <p className="text-quiet text-floor-mute">{hint}</p>

      <ul className="mt-2 flex flex-wrap gap-2">
        {values.map((value) => (
          <li key={value} className="flex items-center gap-1 border border-floor-line px-2 py-1">
            <span className="text-quiet">{value}</span>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              className="min-h-touch px-1 text-floor-mute"
              onClick={() => void onChange(values.filter((entry) => entry !== value))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-2 flex items-center gap-2">
        <input
          className="field"
          value={draft}
          placeholder={`Add to ${label.toLowerCase()}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button type="button" className="btn-text shrink-0 px-0" onClick={() => void add()}>
          Add
        </button>
      </div>
    </div>
  );
}
