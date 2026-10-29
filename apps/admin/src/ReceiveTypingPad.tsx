import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './receiveTypingPad.css';

type Field = HTMLInputElement | HTMLTextAreaElement;
function editable(node: EventTarget | null): node is Field {
  return (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement && ['text','search','number','tel','url','email','password',''].includes(node.type))
    && !node.disabled && !node.readOnly;
}

/** Real DOM input events update React's controlled fields; no Android IME dependency. */
export function typeIntoReceiveField(field: Field, key: string) {
  const value = field.value;
  const start = field.selectionStart ?? value.length, end = field.selectionEnd ?? value.length;
  const next = key === 'Clear' ? '' : key === '⌫'
    ? value.slice(0, start === end ? Math.max(0, start - 1) : start) + value.slice(end)
    : value.slice(0, start) + key + value.slice(end);
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, next);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  const caret = key === 'Clear' ? 0 : key === '⌫' ? Math.max(0, start - (start === end ? 1 : 0)) : start + key.length;
  try { field.setSelectionRange(caret, caret); } catch { /* type=number has no selection API */ }
}

export function ReceiveTypingPad({ children }: { children: ReactNode }) {
  const [field, setField] = useState<Field | null>(null);
  const [display, setDisplay] = useState('');
  const [upper, setUpper] = useState(false);
  const last = useRef<Field | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const label = field?.getAttribute('aria-label') || field?.closest('label')?.childNodes[0]?.textContent?.trim() || 'Selected field';
  function done() {
    field?.blur(); setField(null);
    requestAnimationFrame(() => host.current?.querySelector<HTMLInputElement>('[data-receive-scan]:not(:disabled)')?.focus());
  }
  useEffect(() => {
    if (!field) return;
    const sync = () => { if (!field.isConnected || field.disabled) setField(null); else setDisplay(field.value); };
    field.addEventListener('input', sync);
    const observer = new MutationObserver(sync);
    if (host.current) observer.observe(host.current, { childList: true, subtree: true });
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return () => { field.removeEventListener('input', sync); observer.disconnect(); };
  }, [field]);
  return <div ref={host} className="receive-typing-host" style={{ paddingBottom: field ? 'min(340px, 45vh)' : undefined }}
    onFocusCapture={event => {
      if (!editable(event.target)) return;
      last.current = event.target;
      // HID scan fields keep accepting physical scanner keystrokes without opening the pad.
      if (!event.target.hasAttribute('data-receive-scan')) { setField(event.target); setDisplay(event.target.value); }
    }}>
    {children}
    <button type="button" className="receive-pad-launch" onClick={() => {
      const target = last.current?.isConnected && editable(last.current) ? last.current : host.current?.querySelector<Field>('textarea:not(:disabled),input:not(:disabled):not([type=hidden]):not([type=file])');
      if (target && editable(target)) { setField(target); setDisplay(target.value); }
    }}>Floor keyboard</button>
    {field && createPortal(<div className="receive-typing-pad" role="dialog" aria-label="Floor typing pad" aria-modal="false"
      onPointerDown={event => event.preventDefault()} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); done(); } }}>
      <div className="receive-pad-header"><strong>{label}</strong><button type="button" onClick={done}>Done</button></div>
      <output aria-label="Typed value">{field.type === 'password' ? '•'.repeat(display.length) : display || 'Tap letters or numbers below'}</output>
      {['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '.,-/\'"'].map(row => <div className="receive-pad-row" key={row}>
        {[...row].map(key => <button type="button" key={key} onClick={() => { typeIntoReceiveField(field, upper ? key.toUpperCase() : key); setDisplay(field.value); }}>{upper ? key.toUpperCase() : key}</button>)}
      </div>)}
      <div className="receive-pad-row"><button type="button" aria-pressed={upper} onClick={() => setUpper(!upper)}>Shift</button>
        <button type="button" onClick={() => { typeIntoReceiveField(field, 'Clear'); setDisplay(field.value); }}>Clear</button>
        <button type="button" className="receive-pad-space" onClick={() => { typeIntoReceiveField(field, ' '); setDisplay(field.value); }}>Space</button>
        <button type="button" aria-label="Backspace" onClick={() => { typeIntoReceiveField(field, '⌫'); setDisplay(field.value); }}>⌫</button></div>
    </div>, document.body)}
  </div>;
}
