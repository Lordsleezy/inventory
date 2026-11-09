import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.MANIFEST_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.MANIFEST_PLAYWRIGHT_PATH).href : 'playwright');
const css = await Promise.all([
  readFile('apps/admin/src/style.css', 'utf8'),
  readFile('apps/admin/src/appMode/appMode.css', 'utf8'),
]);

const bays = [
  { bay_no: 1, row_bins: [3, 2, 0] },
  { bay_no: 2, row_bins: [1, 1, 1, 1, 1] },
  { bay_no: 3, row_bins: [1, 1, 1] },
  { bay_no: 4, row_bins: [2, 2] },
  { bay_no: 5, row_bins: [1, 1, 1] },
];
const locations = [
  ['1-1-1', 1, 1, 1, 12], ['1-1-2', 1, 1, 2, 9], ['1-1-3', 1, 1, 3, 4],
  ['1-2-1', 1, 2, 1, 11], ['1-2-2', 1, 2, 2, 6], ['1-3', 1, 3, null, 4],
  ['2-1-1', 2, 1, 1, 43], ['3-1-1', 3, 1, 1, 0], ['4-1-1', 4, 1, 1, 33], ['5-1-1', 5, 1, 1, 8],
].map(([code, bay_no, row_no, bin_no, stock]) => ({ code, bay_no, row_no, bin_no, stock }));
const binItems = [
  { sku: '11652', title: 'Oral-B iO Series 5 toothbrush', quantity: 1, qty_on_hand: 1, is_stocked: false },
  { sku: '11590', title: 'Threshold blackout curtain 54×84', quantity: 4, qty_on_hand: 4, is_stocked: true },
  { sku: '11805', title: 'Ninja permanent coffee filter', quantity: 2, qty_on_hand: 2, is_stocked: true },
  { sku: '11702', title: 'Febreze Air Effects 3-pack', quantity: 3, qty_on_hand: 3, is_stocked: true },
  { sku: '11733', title: 'OXO Good Grips can opener', quantity: 1, qty_on_hand: 1, is_stocked: false },
];

const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LocationsPage } from './apps/admin/src/LocationsPage';

const bays = ${JSON.stringify(bays)};
const locations = ${JSON.stringify(locations)};
const binItems = ${JSON.stringify(binItems)};
const client = {
  rpc: async (name, args) => {
    if (name === 'portal_bay_list') return { data: { bays, locations }, error: null };
    if (name === 'portal_location_units') return { data: args && args.p_code === '1-1-1' ? binItems : [], error: null };
    return { data: null, error: null };
  },
};

function App() {
  const [clerk, setClerk] = useState(location.hash === '#clerk');
  window.__setClerk = (on) => { location.hash = on ? '#clerk' : ''; setClerk(on); };
  return (
    <div className="app-mode-root">
      <main className="app-mode-main">
        <LocationsPage client={client} storeId="s" canManage={!clerk} variant="app" onBack={() => {}} backLabel="More" accessToken="t" money={(n) => '$' + (n / 100).toFixed(2)} />
      </main>
      <nav className="app-tabbar" aria-label="App">
        <button type="button">Inventory</button>
        <button type="button">Receive</button>
        <button type="button">Orders</button>
        <button type="button">Returns</button>
        <button type="button" className="active">More</button>
      </nav>
    </div>
  );
}

document.documentElement.classList.add('app-mode');
document.body.classList.add('app-mode');
createRoot(document.getElementById('root')).render(<App />);
`,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  define: { 'import.meta.env': JSON.stringify({ VITE_FLOOR_FUNCTIONS_URL: 'https://example.test', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }) },
});

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MANIFEST_CHROMIUM_PATH ? { executablePath: process.env.MANIFEST_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});

const shots = 'docs/locations-simplify';
await mkdir(shots, { recursive: true });
const viewports = [
  { name: 'iphone-390', width: 390, height: 844 },
  { name: 'iphone-430', width: 430, height: 932 },
  { name: 'moto-g-play', width: 412, height: 915 },
];

function overlaps(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

try {
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.route('**/*', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><style>html,body,#root{margin:0;height:100%;background:#000}#root{position:relative}${css.join('\n')}</style></head><body><div id="root"></div></body></html>`,
    }));
    await page.goto('https://locations-phone.test');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.getByRole('heading', { name: 'Locations' }).waitFor();
    const overflow = await page.evaluate(() => {
      const screen = document.querySelector('.loc-screen');
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        screen: screen ? screen.scrollWidth - screen.clientWidth : 0,
      };
    });
    assert.ok(overflow.page <= 1 && overflow.screen <= 1, `${vp.name}: horizontal overflow ${JSON.stringify(overflow)}`);
    const heading = await page.getByRole('heading', { name: 'Locations' }).boundingBox();
    const action = await page.getByRole('button', { name: 'New bay' }).boundingBox();
    assert.ok(heading && action && !overlaps(heading, action), `${vp.name}: New bay overlaps the Locations heading`);
    assert.equal(await page.getByText('Bay setup').count(), 0, `${vp.name}: bay setup card is gone`);
    assert.equal(await page.getByText('Recent location history').count(), 0, `${vp.name}: history is not on this screen`);
    await page.screenshot({ path: `${shots}/after-${vp.name}-list.png` });
    if (vp.name === 'iphone-390') {
      await page.getByRole('button', { name: /Bay 1,/ }).click();
      await page.getByRole('heading', { name: 'Bay 1' }).waitFor();
      await page.getByRole('button', { name: 'Floor, 4 units' }).waitFor();
      const bayOverflow = await page.evaluate(() => {
        const screen = document.querySelector('.loc-screen');
        return screen ? screen.scrollWidth - screen.clientWidth : 0;
      });
      assert.ok(bayOverflow <= 1, 'bay screen overflows');
      await page.screenshot({ path: `${shots}/after-iphone-390-bay.png` });
      await page.getByRole('button', { name: 'Bin 1-1-1, 12 units' }).click();
      await page.getByRole('heading', { name: 'Bin 1-1-1' }).waitFor();
      await page.getByText('Oral-B iO Series 5 toothbrush').waitFor();
      await page.getByText('Bay 1 · Row 1 · Bin 1 · 11 units').waitFor();
      const binOverflow = await page.evaluate(() => {
        const screen = document.querySelector('.loc-screen');
        return screen ? screen.scrollWidth - screen.clientWidth : 0;
      });
      assert.ok(binOverflow <= 1, 'bin screen overflows');
      await page.screenshot({ path: `${shots}/after-iphone-390-bin.png` });
      await page.getByRole('button', { name: 'Scan items here' }).click();
      await page.getByRole('heading', { name: 'Scan items here' }).waitFor();
      const scanOverflow = await page.evaluate(() => {
        const screen = document.querySelector('.loc-screen');
        return screen ? screen.scrollWidth - screen.clientWidth : 0;
      });
      assert.ok(scanOverflow <= 1, 'scan screen overflows');
      await page.screenshot({ path: `${shots}/after-iphone-390-scan.png` });
      await page.getByRole('button', { name: '‹ Bin 1-1-1' }).click();
      await page.getByRole('button', { name: '‹ Bay 1' }).click();
      await page.getByRole('button', { name: '‹ Locations' }).click();
      await page.evaluate(() => window.__setClerk(true));
      await page.getByRole('heading', { name: 'Locations' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'New bay' }).count(), 0, 'clerks do not get New bay');
      await page.getByRole('button', { name: /Bay 1,/ }).click();
      assert.equal(await page.getByRole('button', { name: 'Edit' }).count(), 0, 'clerks do not get Edit');
      await page.getByRole('button', { name: 'Bin 1-1-1, 12 units' }).click();
      assert.equal(await page.getByRole('button', { name: 'Scan items here' }).count(), 1, 'clerks can scan into a bin');
    }
    await page.close();
  }
  console.log('PASS: Locations fits 390 / 430 / Moto G Play with no overlap and no horizontal scroll.');
} finally {
  await browser.close();
}
