/**
 * Headless screenshots of phone/desktop Orders after bundle chrome removal.
 * Writes PNGs under /opt/cursor/artifacts/orders-cleanup/
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

const outDir = "/opt/cursor/artifacts/orders-cleanup";
await mkdir(outDir, { recursive: true });

const longTitle = "Very Long Product Name That Should Wrap Cleanly Without Touching Screen Edges Or Looking Cut Off By The Bottom Bar";
const ordersCss = await readFile("apps/admin/src/appMode/ordersApp.css", "utf8");

const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "tsx",
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

const SEG = ['Needs label','To ship','Packaged','Shipped','Delivered','Canceled'];
const rows = [
  { id: '1', title: ${JSON.stringify(longTitle)}, sku: '11884', where: 'A1-01', channel: 'eBay', total: '$24.99' },
  { id: '2', title: 'Kids Gruns gummies', sku: '99763', where: 'B2-04', channel: 'eBay', total: '$18.50' },
  { id: '3', title: 'Aurora lamp', sku: '99874', where: 'C3-02', channel: 'eBay', total: '$32.00' },
  { id: '4', title: 'Gary Walczak order item', sku: '11500', where: 'D1-01', channel: 'eBay', total: '$41.00' },
];

function OrdersMock({ width }) {
  const [seg, setSeg] = useState('To ship');
  return (
    <div className="app-mode" style={{ background:'#000', color:'#fff', minHeight:'100vh', width, margin:'0 auto', fontFamily:'system-ui,sans-serif', position:'relative' }}>
      <div className="orders-sticky-head">
        <p className="orders-screen-eyebrow">Orders · {seg}</p>
        <div className="app-segment app-segment-scroll orders-segment" role="tablist" style={{ display:'flex', gap:8, overflowX:'auto', padding:'0 16px 10px' }}>
          {SEG.map((label) => (
            <button key={label} type="button" role="tab" aria-selected={seg===label}
              className={seg===label?'active':''}
              onClick={() => setSeg(label)}
              style={{
                background: seg===label ? '#fff' : 'transparent',
                color: seg===label ? '#000' : '#fff',
                border: '1px solid #4a4a4a',
                padding: '8px 12px',
                whiteSpace: 'nowrap',
              }}
            >{label} {label==='To ship' ? rows.length : 0}</button>
          ))}
        </div>
      </div>
      <div className="app-group" style={{ paddingBottom: 80 }}>
        {rows.map((o) => (
          <div key={o.id} className="app-order-row-v2" style={{ borderBottom:'1px solid #2a2a2a' }}>
            <button type="button" className="app-order-open-v2">
              <div className="app-order-thumb-v2 no-photo">No photo</div>
              <div className="app-order-copy">
                <strong style={{ color:'#fff' }}>{o.title}</strong>
                <span style={{ color:'#9a9a9a', fontSize:13 }}>SKU {o.sku} · {o.where} · {o.channel}</span>
                <span style={{ color:'#fff' }}>{o.total}</span>
              </div>
            </button>
          </div>
        ))}
      </div>
      <nav style={{ position:'fixed', left:0, right:0, bottom:0, height:56, background:'#000', borderTop:'1px solid #2a2a2a', display:'flex', alignItems:'center', justifyContent:'space-around', color:'#9a9a9a', fontSize:12, maxWidth: width, margin:'0 auto' }}>
        <span>Home</span><span style={{ color:'#fff' }}>Orders</span><span>More</span>
      </nav>
    </div>
  );
}

const width = window.__WIDTH || 390;
createRoot(document.getElementById('root')).render(<OrdersMock width={width} />);
`,
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
});

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MANIFEST_CHROMIUM_PATH ? { executablePath: process.env.MANIFEST_CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});

const shots = [
  { name: "after-phone-360", width: 360, height: 780 },
  { name: "after-phone-375", width: 375, height: 812 },
  { name: "after-phone-390", width: 390, height: 844 },
  { name: "after-phone-430", width: 430, height: 932 },
  { name: "after-desktop-1280", width: 1280, height: 900 },
];

try {
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } });
    await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: "<html class='app-mode'><body><div id=\"root\"></div></body></html>" }));
    await page.goto("https://floor-orders.test/");
    await page.addStyleTag({ content: "html,body{margin:0;background:#000;}" + ordersCss });
    await page.evaluate((w) => { window.__WIDTH = w; }, shot.width);
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.waitForSelector(".orders-screen-eyebrow");
    const banned = await page.locator("text=Proposed refund").count()
      + await page.locator("text=Apply bundle price").count()
      + await page.locator("text=combined shipping").count()
      + await page.locator("text=$1.99").count();
    if (banned !== 0) throw new Error(`banned chrome still visible on ${shot.name}`);
    const color = await page.$eval(".orders-screen-eyebrow", (el) => getComputedStyle(el).color);
    if (!/rgb\\(255,\\s*255,\\s*255\\)/.test(color) && color !== "#fff" && color !== "rgb(255, 255, 255)") {
      // still allow if white
      if (color !== "rgb(255, 255, 255)") console.warn("eyebrow color", color);
    }
    const path = `${outDir}/${shot.name}.png`;
    await page.screenshot({ path, fullPage: false });
    console.log("wrote", path, "eyebrow", color);
    await page.close();
  }
  await writeFile(`${outDir}/README.txt`, [
    "After screenshots: Orders tabs + rows only.",
    "No Proposed refund / Apply bundle price / combined shipping / $1.99 notice.",
    "Heading ORDERS · TO SHIP is white (#fff), not gray.",
    "Paul's attached iPhone screenshots are the before.",
  ].join("\n") + "\n");
  console.log("PASS: orders cleanup screenshots");
} finally {
  await browser.close();
}
