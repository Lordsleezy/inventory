import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const { chromium, devices } = await import(process.env.MANIFEST_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.MANIFEST_PLAYWRIGHT_PATH).href : 'playwright');
const css = await Promise.all([
  readFile('apps/admin/src/style.css', 'utf8'),
  readFile('apps/admin/src/appMode/appMode.css', 'utf8'),
]);

const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReturnsSimplified } from './apps/admin/src/returns/ReturnsSimplified';

const rows = [{
  id: 'r1', sku: '11804', title: 'Ninja 12-cup coffee maker', channel: 'ebay', status: 'in_transit',
  reason: 'other', external_order_id: '12-345', refund_cents: 2500, return_label_cents: 1240,
  label_paid_by: 'seller', tracking_number: '9400111899223344556677', requested_qty: 1, route_to: 'garage', created_at: new Date().toISOString(),
}];

const client = {
  rpc: async (name) => {
    if (name === 'portal_return_desk') return { data: { rows } };
    if (name === 'portal_return_tracking_timeline') return { data: { status_line: 'In transit · arriving Thu', events: [] } };
    return { data: null };
  },
};

function App() {
  return (
    <>
      <ReturnsSimplified client={client} storeId="s" money={(n) => '$' + (n / 100).toFixed(2)} stamp={(s) => s} variant="app" accessToken="t" />
      <nav className="app-tabbar" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: 56, display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', background: '#111' }} />
    </>
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

const viewports = [
  { name: 'iphone-13', width: 390, height: 844 },
  { name: 'iphone-14-pro-max', width: 430, height: 932 },
  { ...devices['Pixel 7'], name: 'moto-class' },
];

try {
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.route('**/*', (r) => r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><style>${css.join('\n')}</style></head><body><div id="root"></div></body></html>`,
    }));
    await page.goto('https://returns-phone.test');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.getByRole('heading', { name: 'Returns' }).waitFor();
    assert.equal(await page.getByPlaceholder('Search SKU or order').count(), 1, `${vp.name}: one search`);
    assert.equal(await page.locator('.returns-row').count(), 1, `${vp.name}: list row`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.ok(overflow, `${vp.name}: no horizontal scroll`);
    await page.screenshot({ path: `scripts/screenshots/returns-after-${vp.width}.png`, fullPage: true });
    await page.close();
  }
  console.log('PASS: Returns list fits 390 / 430 / Moto-class widths with a single search and no horizontal overflow.');
} finally {
  await browser.close();
}
