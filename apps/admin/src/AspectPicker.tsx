import { useRef, useState } from 'react';
import { isListOnly, pickerOptions, valueIsValid, type AspectDef } from './aspectOptions';

type Props = {
  def: AspectDef; value: string; usage?: string[]; suggested?: boolean; disabled?: boolean;
  onChange: (value: string) => void;
};

/**
 * Tap to see eBay's allowed values for this aspect (most used in Floor first); typing filters the list.
 * Free-text aspects also offer "Use '<typed>'"; list-only aspects accept only a value from the list.
 */
export function AspectPicker({ def, value, usage = [], suggested = false, disabled = false, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLInputElement>(null);
  const { options, typed, more } = pickerOptions(def, usage, query);
  const bad = Boolean(value && !valueIsValid(def, value));
  const choose = (v: string) => { onChange(v); setQuery(''); setOpen(false); box.current?.blur(); };

  return <label className={`ebay-specific-field aspect-picker${def.required && (!value || bad) ? ' is-missing' : ''}`}>
    <span>{def.name}{def.required ? ' *' : ''}{suggested && value ? <em className="aspect-suggested">suggested</em> : null}</span>
    <span className="aspect-box">
      <input ref={box} disabled={disabled} value={open ? query : value} placeholder={open ? 'Type to filter' : (isListOnly(def) ? 'Tap to choose' : 'Tap to choose or type')}
        autoComplete="off" role="combobox" aria-expanded={open} aria-label={def.name}
        onFocus={() => { setQuery(''); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); const pick = typed ?? options[0]; if (pick) choose(pick); }
          if (e.key === 'Escape') { setOpen(false); box.current?.blur(); }
        }} />
      {value && !disabled ? <button type="button" className="aspect-clear" aria-label={`Clear ${def.name}`} onMouseDown={e => e.preventDefault()} onClick={() => choose('')}>×</button> : null}
      {open && <ul className="aspect-list" role="listbox">
        {typed && <li><button type="button" onMouseDown={e => e.preventDefault()} onClick={() => choose(typed)}>Use &ldquo;{typed}&rdquo;</button></li>}
        {options.map(v => <li key={v}><button type="button" className={v === value ? 'is-selected' : undefined} onMouseDown={e => e.preventDefault()} onClick={() => choose(v)}>{v}</button></li>)}
        {!typed && options.length === 0 && <li className="aspect-empty">{isListOnly(def) ? 'No matching eBay value' : 'Type a value'}</li>}
        {more > 0 && <li className="aspect-empty">{more} more, keep typing to narrow</li>}
      </ul>}
    </span>
    {bad && <small className="alert">Pick one of eBay&apos;s values.</small>}
  </label>;
}
