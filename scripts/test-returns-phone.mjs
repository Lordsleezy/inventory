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

const openRows = [{
  id: 'r1', sku: '11717', title: 'Phillips Phillips sonicare protective clean 5100 2 pack',
  channel: 'ebay', status: 'requested', reason: 'not_as_described', fault: 'seller',
  external_order_id: '12-345', refund_cents: 5847, return_label_cents: 856,
  label_paid_by: 'seller', tracking_number: null, requested_qty: 1, route_to: 'garage',
  created_at: new Date().toISOString(),
}];
const closedRows = [{
  id: 'r2', sku: '22001', title: 'Closed blender',
  channel: 'amazon', status: 'closed', reason: 'other',
  external_order_id: 'A-1', refund_cents: 1200, return_label_cents: 0,
  label_paid_by: 'seller', tracking_number: '9400', requested_qty: 1, route_to: 'garage',
  created_at: new Date().toISOString(), closed_at: new Date().toISOString(),
}];
const replacementRows = [{
  id: 'r3', sku: '33001', title: 'Replacement lamp', kind: 'replacement',
  channel: 'website', status: 'requested', reason: 'other',
  external_order_id: null, refund_cents: 0, return_label_cents: 500,
  label_paid_by: 'seller', tracking_number: null, requested_qty: 1, route_to: 'garage',
  replacement_sku: '33002', replacement_id: 'rep-1',
  created_at: new Date().toISOString(),
}];

window.__returnFilters = [];
const client = {
  rpc: async (name, args = {}) => {
    if (name === 'portal_return_desk') {
      window.__returnFilters.push(args.p_filter || 'open');
      const filter = args.p_filter || 'open';
      if (filter === 'closed') return { data: { rows: closedRows } };
      if (filter === 'replacements') return { data: { rows: replacementRows } };
      return { data: { rows: openRows } };
    }
    if (name === 'portal_return_tracking_timeline') return { data: { status_line: '', events: [] } };
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
  { name: 'moto-class', width: devices['Pixel 7']?.viewport?.width || 412, height: devices['Pixel 7']?.viewport?.height || 915 },
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
    await page.locator('.returns-row-main strong').filter({ hasText: 'Phillips sonicare' }).waitFor();
    assert.equal(await page.locator('.returns-row').count(), 1, `${vp.name}: open list row`);

    await page.getByRole('tab', { name: 'Closed' }).click();
    await page.locator('.returns-row-main strong').filter({ hasText: 'Closed blender' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Closed' }).getAttribute('aria-selected'), 'true', `${vp.name}: Closed selected`);
    assert.equal(await page.locator('.returns-row').count(), 1, `${vp.name}: closed list row`);

    await page.getByRole('tab', { name: 'Replacements' }).click();
    await page.locator('.returns-row-main strong').filter({ hasText: 'Replacement lamp' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Replacements' }).getAttribute('aria-selected'), 'true', `${vp.name}: Replacements selected`);

    await page.getByRole('tab', { name: /Open/ }).click();
    await page.locator('.returns-row-main strong').filter({ hasText: 'Phillips sonicare' }).waitFor();

    const filters = await page.evaluate(() => window.__returnFilters);
    assert.ok(filters.includes('open'), `${vp.name}: loaded open`);
    assert.ok(filters.includes('closed'), `${vp.name}: loaded closed`);
    assert.ok(filters.includes('replacements'), `${vp.name}: loaded replacements`);

    await page.locator('.returns-row').click();
    await page.getByRole('heading', { level: 2, name: 'Phillips sonicare protective clean 5100 2 pack' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Mark shipped back' }).count(), 1, `${vp.name}: ship action`);
    assert.equal(await page.getByRole('button', { name: 'Add tracking' }).count(), 1, `${vp.name}: add tracking`);
    const confirm = page.getByRole('button', { name: /Confirm refund/ });
    assert.equal(await confirm.count(), 1, `${vp.name}: confirm refund`);
    await page.screenshot({ path: `scripts/screenshots/returns-after-${vp.width}.png`, fullPage: true });
    await page.close();
  }
  console.log('PASS: Returns tabs refetch Open / Closed / Replacements and detail stays readable.');
} finally {
  await browser.close();
}
