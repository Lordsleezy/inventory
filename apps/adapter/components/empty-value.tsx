import { formatUsd } from "@floor/domain";

export function EmptyValue({ children }: { children?: string | number | null }) {
  if (children === null || children === undefined || children === "") {
    return <span className="inline-block min-h-6 min-w-[2ch]" />;
  }
  return <span>{children}</span>;
}

export function Money({ cents }: { cents: number | null }) {
  const text = formatUsd(cents);
  if (!text) return <EmptyValue />;
  return <span className="font-semibold tabular-nums">{text}</span>;
}
