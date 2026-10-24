/** Exact letter-size OpenCV ArUco mat, shared with the Receive measuring step. */
export function MarkerMatPage() {
  return <section className="panel"><h2>Measure mat</h2>
    <p>Print US Letter at 100% / Actual Size. Disable Fit to page. Check the 1.50 inch line with a ruler.</p>
    <a href="/floor-aruco-mat.pdf" target="_blank" rel="noreferrer">Open printable ArUco mat PDF</a>
    <p>In Receive, choose Measure on mat. Take a top photo for length and width, then a side photo with the mat upright for height. Review every number before applying. Weight requires a scale.</p>
  </section>;
}
