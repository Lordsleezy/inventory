import { useState } from "react";
import { Link } from "react-router-dom";
import { floorCloud } from "@floor/cloud";
import { useStore } from "../store";
import { Label, Notice } from "../components/ui";
import { friendlyRpc } from "../rpc";

export function CategoriesScreen() {
  const { settings, session, online, hydrate, ensureOnline } = useStore();
  const manager = session.role !== "staff";
  const cats = settings.categories;
  const [newName, setNewName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [busy, setBusy] = useState(false);

  async function afterRpc(rpcErr: unknown) {
    if (rpcErr) throw rpcErr;
    await hydrate();
  }

  async function run(work: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await ensureOnline();
      await work();
    } catch (err) {
      setError(friendlyRpc(err));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const name = newName.trim();
    if (!name) {
      setError("Enter a category name.");
      return;
    }
    await run(async () => {
      const { error: rpcErr } = await floorCloud().rpc("add_category", { p_name: name });
      await afterRpc(rpcErr);
      setNewName("");
    });
  }

  async function rename(from: string) {
    const to = (drafts[from] ?? from).trim();
    if (!to) {
      setError("Enter a category name.");
      return;
    }
    await run(async () => {
      const { error: rpcErr } = await floorCloud().rpc("rename_category", { p_from: from, p_to: to });
      await afterRpc(rpcErr);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[from];
        return next;
      });
    });
  }

  async function reorder(from: number, to: number) {
    if (to < 0 || to >= cats.length) return;
    const next = [...cats];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    await run(async () => {
      const { error: rpcErr } = await floorCloud().rpc("reorder_categories", { p_names: next });
      await afterRpc(rpcErr);
    });
  }

  async function remove(name: string, destination?: string) {
    await run(async () => {
      const { error: rpcErr } = await floorCloud().rpc("remove_category", {
        p_name: name,
        p_move_to: destination ?? null,
      });
      const msg = friendlyRpc(rpcErr);
      if (rpcErr && /items use this/i.test(msg)) {
        setMoveFor(name);
        setMoveTo(cats.find((c) => c !== name) ?? "");
        setError(msg);
        return;
      }
      await afterRpc(rpcErr);
      setMoveFor(null);
    });
  }

  return (
    <section>
      <p className="text-quiet">
        <Link to="/setup" className="text-floor-accent">
          Setup
        </Link>
        <span className="text-floor-mute"> / Categories</span>
      </p>
      <h1 className="text-title">Categories</h1>
      <p className="mt-2 text-quiet text-floor-mute">
        Same names show on every phone and on the public website. Receive and Edit Unit pick from this list.
      </p>
      <Notice tone="error">{error}</Notice>

      {!manager ? (
        <p className="mt-3 text-quiet">Staff can use these categories but cannot change the list.</p>
      ) : null}

      <ul className="mt-4">
        {cats.map((name, index) => (
          <li key={name} className="border-b border-floor-line py-3">
            {manager ? (
              <input
                className="field"
                value={drafts[name] ?? name}
                disabled={!online || busy}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [name]: e.target.value }))}
              />
            ) : (
              <p className="text-body">{name}</p>
            )}
            {manager ? (
              <div className="mt-2 flex flex-wrap gap-3">
                <button
                  type="button"
                  className="btn-text px-0"
                  disabled={!online || busy || index === 0}
                  onClick={() => void reorder(index, index - 1)}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="btn-text px-0"
                  disabled={!online || busy || index === cats.length - 1}
                  onClick={() => void reorder(index, index + 1)}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="btn-text px-0"
                  disabled={!online || busy || (drafts[name] ?? name).trim() === name}
                  onClick={() => void rename(name)}
                >
                  Save name
                </button>
                <button
                  type="button"
                  className="btn-text px-0 text-floor-danger"
                  disabled={!online || busy || cats.length === 1}
                  onClick={() => void remove(name)}
                >
                  Remove
                </button>
              </div>
            ) : null}
            {moveFor === name ? (
              <div className="mt-3">
                <Label>Move items to</Label>
                <select
                  className="field mt-1"
                  value={moveTo}
                  onChange={(e) => setMoveTo(e.target.value)}
                >
                  {cats
                    .filter((c) => c !== name)
                    .map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="btn-accent mt-2"
                  disabled={!online || busy || !moveTo}
                  onClick={() => void remove(name, moveTo)}
                >
                  Move and remove
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {manager ? (
        <label className="mt-4 block py-3">
          <Label>New category</Label>
          <input
            className="field mt-1"
            value={newName}
            disabled={!online || busy}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="button" className="btn-text px-0 mt-1" disabled={!online || busy} onClick={() => void add()}>
            Add
          </button>
        </label>
      ) : null}
    </section>
  );
}
