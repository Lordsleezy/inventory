import { useEffect, useState } from 'react';

export type PaperSale = {
  id: number; sold_on: string; sku: string; title: string; channel: string;
  measure_cents: number; tax_cents?: number; ship: string | null; bucket: string;
};
export type PaperLine = {
  id: string; label: string; note: string; dollars: number; floor: number; edited: boolean; sales: PaperSale[];
};
export type PaperSigner = { name: string; title: string; date: string; email: string; phone: string; account: string };

type Props = {
  lines: PaperLine[];
  signer: PaperSigner;
  open: boolean;
  locked: boolean;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  dueOn: string;
  scheduleNote: string;
  districtMeasure: number;
  districtMeasureEdited: boolean;
  recordsNote?: string | null;
  roundingNote?: string | null;
  money: (cents: number) => string;
  readOnly?: boolean;
  onDollars?: (id: string, dollars: number | null) => void;
  onSigner?: (field: keyof PaperSigner, value: string) => void;
};

const TOP = ['1', '2', '3'];
const SECTION_A = ['4', '5', '6', '7', '8', '9', '10', 'A11'];
const SECTION_B = ['B1', 'B2', 'B3', 'B4', 'B5'];
const TAX = ['11', '12', '13', '14', '15', '16', '17', '18', '19', '20a', '20b', '20c', '20d', '20e', '21', '22', '23', '24', '25', '26'];

function pretty(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function dollars(n: number) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}
function parseDollars(raw: string) {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function SignerField({ label, value, disabled, onCommit }: { label: string; value: string; disabled?: boolean; onCommit: (value: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label>{label}
      <input aria-label={label} value={text} disabled={disabled} autoComplete="off" onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== value) onCommit(text); }} />
    </label>
  );
}

function Box({ line, money, readOnly, onDollars }: { line: PaperLine; money: (cents: number) => string; readOnly?: boolean; onDollars?: Props['onDollars'] }) {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const shown = text ?? dollars(line.dollars);
  return (
    <div className={`cdtfa-box${line.edited ? ' edited' : ''}`}>
      <div className="cdtfa-box-id">{line.id}</div>
      <div className="cdtfa-box-label">
        <button type="button" className="cdtfa-box-name" onClick={() => line.sales.length && setOpen(!open)} aria-expanded={open}>
          {line.label}
        </button>
        {line.edited && (
          <p className="cdtfa-floor">Floor calculated {dollars(line.floor)}
            {!readOnly && <button type="button" onClick={() => onDollars?.(line.id, null)}>Reset</button>}
          </p>
        )}
        {open && (
          <ul className="cdtfa-sales">
            {line.sales.map((sale, index) => (
              <li key={`${sale.id}-${index}`} className={sale.bucket === 'missing_state' ? 'cdtfa-bad' : ''}>
                <span>{sale.title}<small>{sale.sold_on} · SKU {sale.sku} · {sale.channel}{sale.ship ? ` · ${sale.ship}` : ''}{sale.bucket === 'missing_state' ? ' · ship-to state missing' : ''}</small></span>
                <b>{money(sale.measure_cents)}</b>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="cdtfa-amt">
        <span className="cdtfa-sr">Amount for line {line.id}</span>
        <input
          inputMode="decimal"
          aria-label={`Line ${line.id}`}
          value={shown}
          disabled={readOnly}
          onFocus={() => setText(String(line.dollars))}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const next = parseDollars(text ?? '');
            setText(null);
            if (next == null || next === line.dollars) return;
            onDollars?.(line.id, next);
          }}
        />
      </label>
    </div>
  );
}

function Block({ title, ids, lines, money, readOnly, onDollars }: { title: string; ids: string[]; lines: PaperLine[]; money: Props['money']; readOnly?: boolean; onDollars?: Props['onDollars'] }) {
  const rows = ids.map((id) => lines.find((line) => line.id === id)).filter((line): line is PaperLine => !!line);
  return (
    <section className="cdtfa-block">
      <h3>{title}</h3>
      {rows.map((line) => <Box key={line.id} line={line} money={money} readOnly={readOnly} onDollars={onDollars} />)}
    </section>
  );
}

export function CdtfaPaper(props: Props) {
  const a1 = props.lines.find((line) => line.id === '12')?.dollars ?? 0;
  const [a4Text, setA4Text] = useState<string | null>(null);
  const field = (key: keyof PaperSigner, label: string) => (
    <SignerField label={label} value={props.signer[key]} disabled={props.readOnly} onCommit={(value) => props.onSigner?.(key, value)} />
  );
  return (
    <article className="cdtfa-paper">
      {props.recordsNote && <p className="cdtfa-records">{props.recordsNote}</p>}
      {props.open && <p className="cdtfa-draft">DRAFT — PERIOD OPEN</p>}
      <header className="cdtfa-banner">
        <div>
          <p className="cdtfa-kicker">CDTFA-401-A · REV. 126 (1-26)</p>
          <h2>State, Local and District Sales and Use Tax Return</h2>
          <p className="cdtfa-period-label">{props.periodLabel}</p>
        </div>
        <div className="cdtfa-idgrid">
          <SignerField label="Account number" value={props.signer.account} disabled={props.readOnly} onCommit={(value) => props.onSigner?.('account', value)} />
          <p>Period {pretty(props.periodStart)} – {pretty(props.periodEnd)}</p>
          <p>Due on or before <strong>{pretty(props.dueOn)}</strong></p>
        </div>
      </header>
      {props.locked && <p className="cdtfa-lock">Locked with Books. The numbers and edits on this period no longer change.</p>}
      <Block title="Sales" ids={TOP} lines={props.lines} money={props.money} readOnly={props.readOnly} onDollars={props.onDollars} />
      <Block title="Section A — deductions" ids={SECTION_A} lines={props.lines} money={props.money} readOnly={props.readOnly} onDollars={props.onDollars} />
      <p className="cdtfa-explain">Line 10, other: marketplace facilitator sales (eBay, TikTok Shop, Amazon, Depop, Mercari). Those sales are included in line 1. The marketplace collects and pays that tax.</p>
      <Block title="Section B — deductions" ids={SECTION_B} lines={props.lines} money={props.money} readOnly={props.readOnly} onDollars={props.onDollars} />
      <Block title="Tax" ids={TAX} lines={props.lines} money={props.money} readOnly={props.readOnly} onDollars={props.onDollars} />
      <section className="cdtfa-block">
        <h3>Schedule A2 — district tax</h3>
        <div className="cdtfa-a2line"><span>A1 Transactions subject to tax (line 12)</span><b>{dollars(a1)}</b></div>
        <div className="cdtfa-a2line"><span>A2/A3 Subject only to the 7.25% statewide rate</span><b>{dollars(a1 - props.districtMeasure)}</b></div>
        <label className="cdtfa-a2line">A4 Subject to district tax
          <input
            aria-label="Schedule A2 line A4"
            inputMode="decimal"
            disabled={props.readOnly}
            value={a4Text ?? dollars(props.districtMeasure)}
            onFocus={() => setA4Text(String(props.districtMeasure))}
            onChange={(e) => setA4Text(e.target.value)}
            onBlur={() => {
              const next = parseDollars(a4Text ?? '');
              setA4Text(null);
              if (next == null || next === props.districtMeasure) return;
              props.onDollars?.('A4', next);
            }}
          />
          {props.districtMeasureEdited && !props.readOnly && <button type="button" onClick={() => props.onDollars?.('A4', null)}>Reset</button>}
        </label>
        <p>{props.scheduleNote}</p>
      </section>
      <section className="cdtfa-sign">
        <h3>Sign and date</h3>
        {field('name', 'Name')}
        {field('title', 'Title')}
        {field('date', 'Date')}
        {field('email', 'Email')}
        {field('phone', 'Phone')}
        <p>Preparer <strong>Floor</strong>. Floor does not file this return.</p>
        {props.roundingNote && <p className="cdtfa-round">{props.roundingNote}</p>}
      </section>
    </article>
  );
}
