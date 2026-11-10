/**
 * Headless screenshots: separate rows → select → Bundle → compact bundled card.
 */
import { build } from "esbuild";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const playwrightPath = process.env.MANIFEST_PLAYWRIGHT_PATH
  || (() => { try { return pathToFileURL(require.resolve("playwright")).href; } catch { return null; } })();
if (!playwrightPath) {
  console.error("playwright not found");
  process.exit(1);
}
const { chromium } = await import(playwrightPath);

const outDir = "/opt/cursor/artifacts/order-shipments-select";
await mkdir(outDir, { recursive: true });
const ordersCss = await readFile("apps/admin/src/appMode/ordersApp.css", "utf8");

const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "tsx",
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

const lines = [
  { id: 'a', title: 'Kids Gruns Superfoods greens gummies strawberry burst 35 pack', sku: '99763', where: 'NO LOCATION', price: '$16.99' },
  { id: 'b', title: 'Aurora Candle Warmer Lamp Combo Pack - Black', sku: '99874', where: 'BAY 2 · R2-B1', price: '$19.80' },
  { id: 'c', title: 'APOTHEKE 2 Wick Large White Vetiver Jar Candle 16oz', sku: '99871', where: 'BAY 2 · R2-B1', price: '$20.90' },
];

function Row({ o, selected, onToggle, showCheck }) {
  return (
    <div className={"app-row app-order-row-v2 needs-label" + (selected ? " selected" : "")}>
      <div className="app-order-row-mainline">
        {showCheck && (
          <label className="app-order-check">
            <input type="checkbox" checked={selected} onChange={onToggle} aria-label={"Select SKU " + o.sku} />
          </label>
        )}
        <button type="button" className="app-order-open-v2">
          <span className="app-order-thumb-v2 no-photo">No photo</span>
          <span className="app-order-copy">
            <span className="app-order-title">{o.title}</span>
            <span className="app-order-sku-line"><span className="lbl">SKU</span> <strong>{o.sku}</strong></span>
            <span className="app-order-meta">eBay · {o.price}</span>
            <span className={"app-order-loc" + (o.where === 'NO LOCATION' ? ' missing' : '')}>{o.where}</span>
            <span className="app-order-suggest">Same buyer: Bundle? (3)</span>
            <span className="app-order-problem">Needs label</span>
          </span>
        </button>
      </div>
    </div>
  );
}

function Bundled() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="app-row app-shipment-card compact needs-label">
      <button type="button" className="app-order-open-v2" onClick={() => setExpanded((v) => !v)}>
        <span className="app-shipment-thumbs compact">
          {lines.map((l) => <span key={l.id} className="app-shipment-thumb no-photo">—</span>)}
        </span>
        <span className="app-order-copy">
          <span className="app-order-title">3 items · Ann Du</span>
          <span className="app-order-sku-line clamp-2">Kids Gruns Superfoods greens gummies strawberry burst 35 pack · Aurora Candle Warmer Lamp Combo Pack - Black</span>
          <span className="app-order-meta">eBay · 3 items</span>
          <span className="app-order-loc missing">NO LOCATION</span>
          <span className="app-order-problem">Needs label</span>
        </span>
      </button>
      {expanded && (
        <div className="app-shipment-lines compact">
          {lines.map((l) => (
            <div key={l.id} className="app-shipment-line">
              <span className="app-shipment-line-thumb no-photo">—</span>
              <span className="app-shipment-line-copy">
                <span className="app-order-title clamp-2">{l.title}</span>
                <span className="app-order-sku-line"><span className="lbl">SKU</span> <strong>{l.sku}</strong></span>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="app-order-row-actions">
        <label className="app-order-action-outline app-order-upload-v2">Upload<input type="file" /></label>
        <button type="button" className="app-order-action-outline">Unbundle</button>
      </div>
    </div>
  );
}

function Phone({ width, mode }) {
  const [sel, setSel] = useState(mode === 'select' ? ['a','b','c'] : []);
  const showBar = mode === 'select' && sel.length >= 2;
  return (
    <div className="app-mode" style={{ background:'#000', color:'#fff', minHeight:'100vh', width, margin:'0 auto', fontFamily:'system-ui,sans-serif', position:'relative' }}>
      <div className="orders-sticky-head">
        <p className="orders-screen-eyebrow">Orders · Needs label</p>
        <div style={{ display:'flex', gap:8, overflowX:'auto', padding:'0 16px 10px' }}>
          <button style={{ background:'#fff', color:'#000', border:'1px solid #4a4a4a', padding:'8px 12px' }}>Needs label {mode === 'bundled' ? 1 : 3}</button>
          <button style={{ background:'transparent', color:'#fff', border:'1px solid #4a4a4a', padding:'8px 12px' }}>To ship 0</button>
        </div>
      </div>
      <div className={"app-group" + (showBar ? " has-bundle-bar" : "")}>
        {mode === 'bundled' ? <Bundled /> : lines.map((o) => (
          <Row key={o.id} o={o} showCheck selected={sel.includes(o.id)} onToggle={() => setSel((prev) => prev.includes(o.id) ? prev.filter((id) => id !== o.id) : [...prev, o.id])} />
        ))}
      </div>
      {showBar && (
        <div className="orders-bundle-bar">
          <button type="button" className="orders-bundle-btn">Bundle {sel.length}</button>
        </div>
      )}
      <nav style={{ position:'fixed', left:0, right:0, bottom:0, height:56, background:'#000', borderTop:'1px solid #2a2a2a', display:'flex', alignItems:'center', justifyContent:'space-around', color:'#9a9a9a', fontSize:12, maxWidth: width, margin:'0 auto' }}>
        <span>Inventory</span><span>Receive</span><span style={{ color:'#fff' }}>Orders</span><span>Returns</span><span>More</span>
      </nav>
    </div>
  );
}

function App() {
  const params = new URLSearchParams(location.search);
  return <Phone width={Number(params.get('w') || 390)} mode={params.get('mode') || 'rows'} />;
}

createRoot(document.getElementById('root')).render(<App />);
`,
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
});

const js = outputFiles[0].text;
const html = `<!doctype html><html class="app-mode"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><style>${ordersCss}
body{margin:0;background:#000;color:#fff}
.app-order-action-outline{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 14px;border:1px solid #fff;background:transparent;color:#fff;font-size:14px}
.app-order-row-actions{display:flex;gap:8px;padding:8px 0 0;flex-wrap:wrap}
.app-order-problem{color:#ff453a;font-size:13px}
.app-order-loc.missing{color:#ff453a}
</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
await writeFile(`${outDir}/mock.html`, html);

const browser = await chromium.launch({ headless: true });
const widths = [360, 375, 390, 430];
for (const w of widths) {
  for (const mode of ["rows", "select", "bundled"]) {
    const page = await browser.newPage({ viewport: { width: w, height: 844 } });
    await page.goto(`file://${outDir}/mock.html?w=${w}&mode=${mode}`, { waitUntil: "load" });
    await page.screenshot({ path: `${outDir}/${mode}-${w}.png`, fullPage: true });
    await page.close();
  }
}
await browser.close();
console.log(JSON.stringify({ ok: true, outDir }));
