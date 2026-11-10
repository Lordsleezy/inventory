/**
 * Headless screenshots: bundled Needs label card, checkboxes, Bundle bar.
 * Writes PNGs under /opt/cursor/artifacts/order-shipments/
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

const outDir = "/opt/cursor/artifacts/order-shipments";
await mkdir(outDir, { recursive: true });
const ordersCss = await readFile("apps/admin/src/appMode/ordersApp.css", "utf8");

const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "tsx",
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

const SEG = [
  ['Needs label', 1],
  ['To ship', 0],
  ['Packaged', 0],
  ['Shipped', 0],
];
const lines = [
  { id: 'a', title: 'Kids Gruns Superfoods greens gummies strawberry burst 35 pack', sku: '99763', where: 'NO LOCATION' },
  { id: 'b', title: 'Aurora Candle Warmer Lamp Combo Pack - Black', sku: '99874', where: 'BAY 2 · R2-B1' },
  { id: 'c', title: 'APOTHEKE 2 Wick Large White Vetiver Jar Candle 16oz', sku: '99871', where: 'BAY 2 · R2-B1' },
];

function OrdersMock({ width, showBundle }) {
  const [expanded, setExpanded] = useState(true);
  const [selected, setSelected] = useState(showBundle);
  return (
    <div className="app-mode" style={{ background:'#000', color:'#fff', minHeight:'100vh', width, margin:'0 auto', fontFamily:'system-ui,sans-serif', position:'relative' }}>
      <div className="orders-sticky-head">
        <p className="orders-screen-eyebrow">Orders · Needs label</p>
        <div className="app-segment app-segment-scroll orders-segment" role="tablist" style={{ display:'flex', gap:8, overflowX:'auto', padding:'0 16px 10px' }}>
          {SEG.map(([label, n]) => (
            <button key={label} type="button" role="tab" aria-selected={label==='Needs label'}
              className={label==='Needs label'?'active':''}
              style={{
                background: label==='Needs label' ? '#fff' : 'transparent',
                color: label==='Needs label' ? '#000' : '#fff',
                border: '1px solid #4a4a4a',
                padding: '8px 12px',
                whiteSpace: 'nowrap',
              }}
            >{label} {n}</button>
          ))}
        </div>
      </div>
      <div className={"app-group" + (showBundle ? " has-bundle-bar" : "")}> 
        <div className={"app-row app-shipment-card needs-label" + (selected ? " selected" : "")}>
          <div className="app-order-row-mainline">
            <label className="app-order-check">
              <input type="checkbox" checked={selected} onChange={() => setSelected((v) => !v)} aria-label="Select 3-item shipment" />
            </label>
            <button type="button" className="app-order-open-v2" onClick={() => setExpanded((v) => !v)}>
              <span className="app-shipment-thumbs">
                {lines.map((l) => <span key={l.id} className="app-shipment-thumb no-photo">—</span>)}
              </span>
              <span className="app-order-copy">
                <span className="app-order-title">3 items · Ann Du</span>
                <span className="app-order-sku-line">{lines[0].title}</span>
                <span className="app-order-meta">eBay · 3 items</span>
                <span className="app-order-meta">Box 10×8×6 in · 6 lb</span>
                <span className="app-order-loc missing">NO LOCATION</span>
                <span className="app-order-problem">Needs label</span>
              </span>
            </button>
          </div>
          {expanded && (
            <div className="app-shipment-lines">
              {lines.map((l) => (
                <div key={l.id} className="app-shipment-line">
                  <span className="app-shipment-line-thumb no-photo">—</span>
                  <span className="app-shipment-line-copy">
                    <span className="app-order-title">{l.title}</span>
                    <span className="app-order-sku-line"><span className="lbl">SKU</span> <strong>{l.sku}</strong></span>
                    <span className={"app-order-loc" + (l.where === 'NO LOCATION' ? ' missing' : '')}>{l.where}</span>
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
        {!showBundle && (
          <div className="app-row app-order-row-v2 needs-label">
            <div className="app-order-row-mainline">
              <label className="app-order-check"><input type="checkbox" aria-label="Select other" /></label>
              <button type="button" className="app-order-open-v2">
                <span className="app-order-thumb-v2 no-photo">No photo</span>
                <span className="app-order-copy">
                  <span className="app-order-title">Another buyer item</span>
                  <span className="app-order-sku-line"><span className="lbl">SKU</span> <strong>99001</strong></span>
                  <span className="app-order-meta">eBay · $12.00</span>
                  <span className="app-order-loc">BAY 1 · R1-B1</span>
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
      {showBundle && (
        <div className="orders-bundle-bar">
          <button type="button" className="orders-bundle-btn">Bundle 3</button>
        </div>
      )}
      <nav style={{ position:'fixed', left:0, right:0, bottom:0, height:56, background:'#000', borderTop:'1px solid #2a2a2a', display:'flex', alignItems:'center', justifyContent:'space-around', color:'#9a9a9a', fontSize:12, maxWidth: width, margin:'0 auto' }}>
        <span>Inventory</span><span>Receive</span><span style={{ color:'#fff' }}>Orders</span><span>Returns</span><span>More</span>
      </nav>
    </div>
  );
}

function DeskMock() {
  return (
    <div style={{ background:'#000', color:'#fff', minHeight:'100vh', padding:24, fontFamily:'system-ui,sans-serif' }}>
      <div style={{ letterSpacing:'0.08em', fontSize:12, color:'#9a9a9a' }}>WEBSITE AND MARKETPLACES</div>
      <h1 style={{ margin:'4px 0 16px', fontSize:28 }}>Orders</h1>
      <div style={{ display:'flex', gap:8, marginBottom:16 }}>
        {[['Needs label',1],['To ship',0],['Packaged',0]].map(([label,n]) => (
          <button key={label} style={{ background: label==='Needs label'?'#fff':'transparent', color: label==='Needs label'?'#000':'#fff', border:'1px solid #4a4a4a', padding:'8px 12px' }}>{label} {n}</button>
        ))}
      </div>
      <table style={{ width:'100%', borderCollapse:'collapse' }}>
        <thead><tr style={{ textAlign:'left', color:'#9a9a9a' }}><th></th><th>Order</th><th>Item</th><th>Channel</th><th>Status</th><th>Total</th></tr></thead>
        <tbody>
          <tr style={{ borderTop:'1px solid #2a2a2a' }}>
            <td><input type="checkbox" checked readOnly /></td>
            <td>3 items<br /><button style={{ background:'none', border:0, color:'#9a9a9a' }}>Unbundle</button></td>
            <td>3 items · Ann Du<br /><small style={{ color:'#9a9a9a' }}>BAY 2 · R2-B1</small></td>
            <td>eBay</td>
            <td>Needs label</td>
            <td>$57.75</td>
          </tr>
        </tbody>
      </table>
      <div className="orders-bundle-bar desk-bundle-bar" style={{ position:'fixed', left:0, right:0, bottom:0, padding:'10px 16px', background:'#000', borderTop:'1px solid #2a2a2a' }}>
        <button className="orders-bundle-btn" style={{ width:'100%', minHeight:48, border:0, background:'#fff', color:'#000', fontWeight:700 }}>Bundle 3</button>
      </div>
    </div>
  );
}

function App() {
  const params = new URLSearchParams(location.search);
  const width = Number(params.get('w') || 390);
  const mode = params.get('mode') || 'phone';
  if (mode === 'desk') return <DeskMock />;
  return <OrdersMock width={width} showBundle={params.get('bundle') !== '0'} />;
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
.app-order-row-actions{display:flex;gap:8px;padding:8px 0 0 38px;flex-wrap:wrap}
.app-order-problem{color:#ff453a;font-size:13px}
.app-order-loc.missing{color:#ff453a}
</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
const pagePath = `${outDir}/mock.html`;
await writeFile(pagePath, html);

const browser = await chromium.launch({ headless: true });
const widths = [360, 375, 390, 430];
for (const w of widths) {
  for (const bundle of [1, 0]) {
    const page = await browser.newPage({ viewport: { width: w, height: 844 } });
    await page.goto(`file://${pagePath}?w=${w}&bundle=${bundle}`, { waitUntil: "load" });
    const name = bundle ? `needs-label-bundle-${w}` : `needs-label-card-${w}`;
    await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
    await page.close();
  }
}
const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await desk.goto(`file://${pagePath}?mode=desk`, { waitUntil: "load" });
await desk.screenshot({ path: `${outDir}/desktop-needs-label.png`, fullPage: true });
await browser.close();
console.log(JSON.stringify({ ok: true, outDir, files: [...widths.flatMap((w) => [`needs-label-bundle-${w}.png`, `needs-label-card-${w}.png`]), "desktop-needs-label.png"] }));
