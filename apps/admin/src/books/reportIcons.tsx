type IconProps = { color: string; className?: string };

export function BooksIconSales({ color }: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="none">
      <rect width="24" height="24" rx="6" fill={color} opacity=".25" />
      <path d="M6 17V9l6-3 6 3v8" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 14l3 2 3-2" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function BooksIconExpenses({ color }: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="none">
      <rect width="24" height="24" rx="6" fill={color} opacity=".25" />
      <path d="M7 9h10M7 13h7" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <rect x="6" y="6" width="12" height="14" rx="2" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

export function BooksIconPayouts({ color }: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="none">
      <rect width="24" height="24" rx="6" fill={color} opacity=".25" />
      <path d="M6 10h12v8H6z" stroke={color} strokeWidth="1.6" />
      <path d="M9 10V7h6v3" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function BooksIconInventory({ color }: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="none">
      <rect width="24" height="24" rx="6" fill={color} opacity=".25" />
      <path d="M8 9h8v9H8z" stroke={color} strokeWidth="1.6" />
      <path d="M10 7h4v2h-4z" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

export function BooksIconReceived({ color }: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="none">
      <rect width="24" height="24" rx="6" fill={color} opacity=".25" />
      <path d="M12 6v9" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8 12l4 4 4-4" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
