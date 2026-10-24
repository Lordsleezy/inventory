/**
 * Printable letter-size scale mat for Receive photo measuring.
 * Four 50mm reference squares — print at 100% (no "fit to page").
 */
export function MarkerMatPage() {
  return (
    <section className="panel marker-mat-page">
      <h2>Measure mat</h2>
      <p className="hint">
        Print this page at <strong>100% scale</strong> (turn off “fit to page”). Place the item on the mat and take one photo
        so the black squares are visible — Floor can use them as a 50&nbsp;mm scale.
      </p>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => window.print()}>
          Print / save PDF
        </button>
      </div>
      <div className="marker-mat-sheet" aria-label="Letter measure mat">
        <svg viewBox="0 0 816 1056" width="100%" role="img">
          <title>Floor 50mm measure mat</title>
          <rect x="0" y="0" width="816" height="1056" fill="#fff" />
          <text x="408" y="48" textAnchor="middle" fontFamily="Georgia, serif" fontSize="22" fill="#111">
            Floor measure mat — each square is 50 mm (1.97 in)
          </text>
          <text x="408" y="72" textAnchor="middle" fontFamily="system-ui,sans-serif" fontSize="12" fill="#444">
            Print at 100%. Place product between the squares. One photo is enough.
          </text>
          {/* 50mm at 96dpi ≈ 189px; letter 8.5x11 at 96dpi = 816x1056 */}
          <rect x="48" y="120" width="189" height="189" fill="#000" />
          <rect x="579" y="120" width="189" height="189" fill="#000" />
          <rect x="48" y="747" width="189" height="189" fill="#000" />
          <rect x="579" y="747" width="189" height="189" fill="#000" />
          <text x="142" y="330" textAnchor="middle" fontFamily="system-ui,sans-serif" fontSize="14" fill="#111">
            50 mm
          </text>
          <text x="673" y="330" textAnchor="middle" fontFamily="system-ui,sans-serif" fontSize="14" fill="#111">
            50 mm
          </text>
          <text x="142" y="960" textAnchor="middle" fontFamily="system-ui,sans-serif" fontSize="14" fill="#111">
            50 mm
          </text>
          <text x="673" y="960" textAnchor="middle" fontFamily="system-ui,sans-serif" fontSize="14" fill="#111">
            50 mm
          </text>
          <rect x="280" y="400" width="256" height="256" fill="none" stroke="#bbb" strokeDasharray="8 6" />
          <text x="408" y="535" textAnchor="middle" fontFamily="system-ui,sans-serif" fontSize="16" fill="#666">
            Place item here
          </text>
        </svg>
      </div>
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .marker-mat-sheet, .marker-mat-sheet * { visibility: visible !important; }
          .marker-mat-sheet { position: absolute; left: 0; top: 0; width: 8.5in; }
          .marker-mat-page h2, .marker-mat-page .hint, .marker-mat-page .actions { display: none !important; }
        }
      `}</style>
    </section>
  );
}
