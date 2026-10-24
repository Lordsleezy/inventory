/** On-screen number pad for store-phone Receive — bypasses broken/hidden Gboard. */

type Props = {
  value: string;
  onChange: (next: string) => void;
  /** Allow a decimal point (price / weight). */
  decimal?: boolean;
  ariaLabel?: string;
};

export function StoreNumPad({ value, onChange, decimal = true, ariaLabel = 'Number pad' }: Props) {
  const keys = decimal
    ? ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']
    : ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];

  function press(k: string) {
    if (k === '⌫') {
      onChange(value.slice(0, -1));
      return;
    }
    if (k === 'C') {
      onChange('');
      return;
    }
    if (k === '.') {
      if (!decimal || value.includes('.')) return;
      onChange(value ? `${value}.` : '0.');
      return;
    }
    // Cap length so a wedged scanner can't flood the field via the pad.
    if (value.replace(/\D/g, '').length >= 8) return;
    onChange(value + k);
  }

  return (
    <div className="store-num-pad" role="group" aria-label={ariaLabel}>
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          className={k === '⌫' || k === 'C' ? 'store-num-pad-key muted' : 'store-num-pad-key'}
          onClick={() => press(k)}
        >
          {k}
        </button>
      ))}
    </div>
  );
}
