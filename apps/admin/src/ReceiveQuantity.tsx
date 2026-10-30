import { useEffect, useState } from 'react';
export function ReceiveQuantity({ value, onChange, disabled = false }: { value: string; onChange: (n: string) => void; disabled?: boolean }) {
  const n = Math.max(1, Math.min(100, Number(value) || 1));
  return <fieldset disabled={disabled} className="receive-quantity"><legend>Quantity · more than one creates a stocked SKU</legend><div style={{display:'flex',gap:16,alignItems:'center'}}>
    <button type="button" style={{minWidth:56,minHeight:56,fontSize:28}} disabled={n<=1} aria-label="Decrease receive quantity" onClick={()=>onChange(String(n-1))}>−</button>
    <output style={{fontSize:28,minWidth:50,textAlign:'center'}} aria-live="polite">{value}</output>
    <button type="button" style={{minWidth:56,minHeight:56,fontSize:28}} disabled={n>=100} aria-label="Increase receive quantity" onClick={()=>onChange(String(n+1))}>+</button>
  </div><small>1–100 identical units. Quantity 1 keeps its own SKU; larger quantities share one SKU. Price and entered cost are per unit.</small></fieldset>;
}
