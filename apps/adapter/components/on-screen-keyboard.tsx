"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const LETTERS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];

const SYMBOLS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["-", "_", "@", ".", ",", "/", "&", "'", '"'],
  ["(", ")", "#", "$", "%", "!", "?", "+"],
];

function isEditable(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function skipField(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (el.dataset.floorOsk === "off") return true;
  if (el.closest("[data-floor-osk='off']")) return true;
  if (el.readOnly || el.disabled) return true;
  if (el instanceof HTMLInputElement) {
    const skip = new Set(["hidden", "checkbox", "radio", "button", "submit", "file", "range", "color"]);
    if (skip.has(el.type)) return true;
  }
  return false;
}

function insertText(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  setNativeValue(el, next);
  const pos = start + text.length;
  el.setSelectionRange(pos, pos);
}

function backspace(el: HTMLInputElement | HTMLTextAreaElement) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  if (start !== end) {
    const next = el.value.slice(0, start) + el.value.slice(end);
    setNativeValue(el, next);
    el.setSelectionRange(start, start);
    return;
  }
  if (start === 0) return;
  const next = el.value.slice(0, start - 1) + el.value.slice(end);
  setNativeValue(el, next);
  el.setSelectionRange(start - 1, start - 1);
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  const prev = el.value;
  const tracker = (el as { _valueTracker?: { setValue: (next: string) => void } })._valueTracker;
  tracker?.setValue(prev);
  desc?.set?.call(el, value);
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: value.length >= prev.length ? "insertText" : "deleteContentBackward",
      data: value.length > prev.length ? value.slice(prev.length) : null,
    }),
  );
}

function fieldMode(el: HTMLInputElement | HTMLTextAreaElement): "text" | "numeric" {
  if (el instanceof HTMLInputElement) {
    if (el.inputMode === "numeric" || el.inputMode === "decimal" || el.type === "number") return "numeric";
  }
  return "text";
}

export function OnScreenKeyboard() {
  const [tablet, setTablet] = useState(false);
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const [numeric, setNumeric] = useState(false);
  const target = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const refreshTablet = useCallback(() => {
    fetch("/api/input/keyboard")
      .then((res) => (res.ok ? res.json() : { tablet: false }))
      .then((data) => setTablet(Boolean(data.tablet)))
      .catch(() => setTablet(false));
  }, []);

  useEffect(() => {
    refreshTablet();
    const id = window.setInterval(refreshTablet, 2000);
    return () => window.clearInterval(id);
  }, [refreshTablet]);

  useEffect(() => {
    if (!tablet) {
      setOpen(false);
      document.body.style.removeProperty("padding-bottom");
      document.documentElement.removeAttribute("virtualkeyboardpolicy");
      return;
    }
    document.documentElement.setAttribute("virtualkeyboardpolicy", "manual");

    function onFocusIn(e: FocusEvent) {
      if (!isEditable(e.target) || skipField(e.target)) return;
      target.current = e.target;
      setNumeric(fieldMode(e.target) === "numeric");
      setSymbols(false);
      setOpen(true);
      e.target.setAttribute("inputmode", "none");
    }

    function onFocusOut() {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest("[data-floor-osk-bar]")) return;
        if (isEditable(active) && !skipField(active)) return;
        target.current = null;
        setOpen(false);
      }, 80);
    }

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.body.style.removeProperty("padding-bottom");
      document.documentElement.removeAttribute("virtualkeyboardpolicy");
    };
  }, [tablet]);

  useEffect(() => {
    document.body.style.paddingBottom = open ? "min(42vh, 22rem)" : "";
  }, [open]);

  if (!tablet || !open) return null;

  function press(raw: string) {
    const el = target.current;
    if (!el) return;
    el.focus();
    const ch = shift ? raw.toUpperCase() : raw;
    insertText(el, ch);
    if (shift) setShift(false);
  }

  function doBackspace() {
    const el = target.current;
    if (!el) return;
    el.focus();
    backspace(el);
  }

  function doEnter() {
    const el = target.current;
    if (!el) return;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const form = el.form;
    if (form && el instanceof HTMLInputElement) form.requestSubmit();
  }

  const rows = numeric
    ? [
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"],
        [".", "0", "back"],
      ]
    : symbols
      ? SYMBOLS
      : LETTERS;

  return (
    <div
      data-floor-osk-bar
      className="fixed inset-x-0 bottom-0 z-50 border-t border-floor-line bg-floor-panel px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="mx-auto grid max-w-3xl gap-1.5">
        {rows.map((row, i) => (
          <div key={i} className="flex justify-center gap-1.5">
            {!numeric && i === 2 && !symbols ? (
              <Key wide label={shift ? "ABC" : "⇧"} onClick={() => setShift((s) => !s)} />
            ) : null}
            {row.map((key) =>
              key === "back" ? (
                <Key key="back" wide label="⌫" onClick={doBackspace} />
              ) : (
                <Key key={key} label={shift ? key.toUpperCase() : key} onClick={() => press(key)} />
              ),
            )}
            {!numeric && i === 2 ? <Key wide label="⌫" onClick={doBackspace} /> : null}
          </div>
        ))}
        <div className="flex justify-center gap-1.5">
          {numeric ? (
            <>
              <Key wide label="ABC" onClick={() => setNumeric(false)} />
              <Key wide label="hide" onClick={() => setOpen(false)} />
              <Key wide label="Enter" onClick={doEnter} />
            </>
          ) : (
            <>
              <Key wide label={symbols ? "ABC" : "123"} onClick={() => setSymbols((s) => !s)} />
              <Key extraWide label="space" onClick={() => press(" ")} />
              <Key wide label="Enter" onClick={doEnter} />
              <Key wide label="hide" onClick={() => setOpen(false)} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Key({
  label,
  onClick,
  wide,
  extraWide,
}: {
  label: string;
  onClick: () => void;
  wide?: boolean;
  extraWide?: boolean;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onClick}
      className={`min-h-12 rounded-lg bg-black text-lg font-bold text-floor-text active:bg-floor-accent active:text-black ${
        extraWide ? "min-w-[40%] flex-1" : wide ? "min-w-16 px-3" : "min-w-9 flex-1"
      }`}
    >
      {label}
    </button>
  );
}
