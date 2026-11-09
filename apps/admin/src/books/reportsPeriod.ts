export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

const QUARTER_LABELS = ['Q1 · Jan – Mar', 'Q2 · Apr – Jun', 'Q3 · Jul – Sep', 'Q4 · Oct – Dec'] as const;

export type PeriodChoice = {
  id: string;
  group: 'Quarters' | 'Months';
  label: string;
  disabled: boolean;
  inProgress: boolean;
};

export function periodChoices(year: number, today: Date): PeriodChoice[] {
  const y = today.getFullYear();
  const month = today.getMonth() + 1;
  const quarters: PeriodChoice[] = QUARTER_LABELS.map((label, index) => {
    const start = index * 3 + 1;
    const end = start + 2;
    const future = year > y || (year === y && start > month);
    const current = year === y && month >= start && month <= end;
    return {
      id: `q${index + 1}`,
      group: 'Quarters',
      label: current ? `${label} · in progress` : label,
      disabled: future,
      inProgress: current,
    };
  });
  const months: PeriodChoice[] = MONTH_NAMES.map((name, index) => {
    const n = index + 1;
    const future = year > y || (year === y && n > month);
    const current = year === y && n === month;
    return {
      id: `m${n}`,
      group: 'Months',
      label: current ? `${name} · in progress` : name,
      disabled: future,
      inProgress: current,
    };
  });
  return [...quarters, ...months];
}

export function defaultPeriodId(today: Date) {
  return `m${today.getMonth() + 1}`;
}

export function yearsFrom(firstYear: number, today: Date) {
  const end = today.getFullYear();
  const start = Math.min(firstYear, end);
  const years: number[] = [];
  for (let year = start; year <= end; year += 1) years.push(year);
  return years;
}

export function choiceBounds(year: number, id: string) {
  if (id.startsWith('q')) {
    const q = Number(id.slice(1));
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const endDay = new Date(year, endMonth, 0).getDate();
    return {
      span: 'quarter' as const,
      start: `${year}-${String(startMonth).padStart(2, '0')}-01`,
      end: `${year}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`,
    };
  }
  const month = Number(id.slice(1));
  const endDay = new Date(year, month, 0).getDate();
  return {
    span: 'month' as const,
    start: `${year}-${String(month).padStart(2, '0')}-01`,
    end: `${year}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`,
  };
}

export function reportFileStem(year: number, id: string) {
  if (id.startsWith('q')) return `Open-Box_Reports_${year}-${id.toUpperCase()}`;
  const month = Number(id.slice(1));
  return `Open-Box_Reports_${year}-${String(month).padStart(2, '0')}`;
}
