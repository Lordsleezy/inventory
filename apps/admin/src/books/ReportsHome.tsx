import { useEffect, useState } from 'react';
import type { PeriodChoice } from './reportsPeriod';

type Props = {
  year: number;
  years: number[];
  onYear: (year: number) => void;
  pick: string;
  choices: PeriodChoice[];
  onPick: (id: string) => void;
  busy: '' | 'sheet' | 'tax' | 'view-sheet' | 'view-tax' | 'full';
  error: string;
  onSheet: () => void;
  onTax: () => void;
  onViewSheet: () => void;
  onViewTax: () => void;
  onFull: () => void;
};

export function ReportsHome(props: Props) {
  const [sheet, setSheet] = useState(false);
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 800px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 800px)');
    const apply = () => setPhone(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
  const selected = props.choices.find((row) => row.id === props.pick);
  const label = (selected?.label || 'Month').replace(' · in progress', '');

  return (
    <div className="reports-home">
      <h1>Reports</h1>
      <div className="reports-picks">
        <select aria-label="Year" value={props.year} onChange={(e) => props.onYear(Number(e.target.value))}>
          {props.years.map((year) => <option key={year} value={year}>{year}</option>)}
        </select>
        {phone ? (
          <button type="button" className="reports-pick" aria-label="Period" onClick={() => setSheet(true)}>{label}</button>
        ) : (
          <select aria-label="Period" value={props.pick} onChange={(e) => props.onPick(e.target.value)}>
            <optgroup label="Quarters">
              {props.choices.filter((row) => row.group === 'Quarters').map((row) => (
                <option key={row.id} value={row.id} disabled={row.disabled}>{row.label}</option>
              ))}
            </optgroup>
            <optgroup label="Months">
              {props.choices.filter((row) => row.group === 'Months').map((row) => (
                <option key={row.id} value={row.id} disabled={row.disabled}>{row.label}</option>
              ))}
            </optgroup>
          </select>
        )}
      </div>
      <div className="reports-actions">
        <button type="button" disabled={!!props.busy} onClick={props.onSheet}>{props.busy === 'sheet' ? 'Building…' : 'Download spreadsheet'}</button>
        <button type="button" className="secondary" disabled={!!props.busy} onClick={props.onTax}>{props.busy === 'tax' ? 'Building…' : 'Download sales tax report'}</button>
      </div>
      <div className="reports-actions">
        <button type="button" className="secondary" disabled={!!props.busy} onClick={props.onViewSheet}>{props.busy === 'view-sheet' ? 'Building…' : 'View spreadsheet ↗'}</button>
        <button type="button" className="secondary" disabled={!!props.busy} onClick={props.onViewTax}>{props.busy === 'view-tax' ? 'Building…' : 'View sales tax report ↗'}</button>
      </div>
      <p className="reports-note">View opens the file in a new browser tab.</p>
      {props.error && (
        <p className="reports-error" role="alert">
          {props.error}{' '}
          <button type="button" className="text-button" onClick={props.onSheet}>Try again</button>
        </p>
      )}
      <button type="button" className="reports-full text-button" disabled={!!props.busy} onClick={props.onFull}>Download full form</button>
      {sheet && (
        <div className="reports-sheet" role="dialog" aria-label="Period">
          <button type="button" className="reports-sheet-back" onClick={() => setSheet(false)}>Close</button>
          <div className="reports-sheet-card">
            <p>Quarters</p>
            {props.choices.filter((row) => row.group === 'Quarters').map((row) => (
              <button key={row.id} type="button" disabled={row.disabled} aria-current={row.id === props.pick} onClick={() => { props.onPick(row.id); setSheet(false); }}>
                {row.label}{row.id === props.pick ? ' ✓' : ''}
              </button>
            ))}
            <p>Months</p>
            {props.choices.filter((row) => row.group === 'Months').map((row) => (
              <button key={row.id} type="button" disabled={row.disabled} aria-current={row.id === props.pick} onClick={() => { props.onPick(row.id); setSheet(false); }}>
                {row.label}{row.id === props.pick ? ' ✓' : ''}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
