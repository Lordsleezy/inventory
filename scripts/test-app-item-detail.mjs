import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.MANIFEST_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.MANIFEST_PLAYWRIGHT_PATH).href : 'playwright');
const css = await Promise.all([
  readFile('apps/admin/src/style.css', 'utf8'),
  readFile('apps/admin/src/appMode/appMode.css', 'utf8'),
  readFile('apps/admin/src/design/bw.css', 'utf8'),
]);
await mkdir('/opt/cursor/artifacts', { recursive: true });

const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppItemDetail } from './apps/admin/src/appMode/AppItemDetail';

const unit = {
  sku: '99999', brand: 'Threshold', model: '50\\"x63\\" Blackout Aruba Tie-Top Curtain Panel, Sour Cream',
  title: 'Threshold 50\\"x63\\" Blackout Aruba Tie-Top Curtain Panel, Sour Cream',
  condition: 'Used - Good', ask_cents: 2000, state: 'available', qty_on_hand: 1, is_stocked: false,
  upc: '', package_length_in: 16, package_width_in: 12, package_height_in: 3, package_weight_lb: 3.5,
  listing_body: '', received_at: '2026-10-31T12:00:00Z', test_status: '', category: '',
  acquisition_cost_cents: 400, fulfillment_override: null, shippable: true, upc_does_not_apply: false,
};
const photos = [{ id: 1, path: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/99999/a.jpg', is_primary: true, source: 'stock' }];
const listings = [
  { channel: 'ebay', status: 'listed', listing_id: '1', price_cents: 2000 },
  { channel: 'website', status: 'delisted', listing_id: null },
  { channel: 'tiktok', status: '', listing_id: null },
];

const client = {
  rpc: async (name, args) => {
    window.rpcCalls.push({ name, args });
    if (name === 'staff_inventory_detail') return { data: { unit: { ...unit, acquisition_cost_cents: undefined, shippable: undefined, fulfillment_override: undefined }, photos, listings: [] } };
    if (name === 'portal_inventory_detail') return { data: { unit, photos, listings, sales: [] } };
    if (name === 'portal_unit_dns') return { data: { dns: false } };
    if (name === 'portal_unit_history') return { data: [] };
    if (name === 'staff_set_unit_upc' || name === 'portal_set_unit_upc') {
      window.upcSaved = args;
      return { data: { sku: '99999', upc: args.p_upc === 'Does not apply' ? null : args.p_upc, upc_does_not_apply: args.p_upc === 'Does not apply' } };
    }
    if (name === 'portal_bay_list') return { data: { bays: [], locations: [] } };
    if (name === 'portal_location_unit') return { data: { sku: '99999', title: unit.title, qty_on_hand: 1, is_stocked: false, allocations: [] } };
    return { data: null };
  },
  from: () => ({
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null }), then: undefined, data: [] }),
        in: () => ({ in: () => ({ limit: async () => ({ data: [] }) }) }),
        order: async () => ({ data: [] }),
        data: [],
      }),
    }),
  }),
  storage: { from: () => ({ createSignedUrls: async () => ({ data: [{ signedUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#ccc"/><text x="40" y="200" font-size="28">Curtain</text></svg>') }] }) }) },
};
client.from = (table) => {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    in() { return chain; },
    limit: async () => ({ data: [] }),
    order: async () => ({ data: [] }),
    maybeSingle: async () => ({ data: null }),
    then(resolve) { return Promise.resolve({ data: [] }).then(resolve); },
  };
  return chain;
};

window.rpcCalls = [];
window.renderClerk = () => createRoot(document.getElementById('root')).render(
  <AppItemDetail client={client} storeId="store" accessToken="t" sku="99999" money={(n) => '$' + (n/100).toFixed(2)} staffMode canDelete={false} onBack={()=>{}} onChanged={()=>{}} onSellInStore={()=>{}} />
);
window.renderAdmin = () => createRoot(document.getElementById('root')).render(
  <AppItemDetail client={client} storeId="store" accessToken="t" sku="99999" money={(n) => '$' + (n/100).toFixed(2)} canDelete onBack={()=>{}} onChanged={()=>{}} onSellInStore={()=>{}} />
);
document.documentElement.classList.add('app-mode');
window.renderClerk();
`,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  define: { 'import.meta.env': JSON.stringify({ VITE_FLOOR_FUNCTIONS_URL: '', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }) },
});

const browser = await chromium.launch({
  headless: true,
  ...(process.env.MANIFEST_CHROMIUM_PATH ? { executablePath: process.env.MANIFEST_CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});

try {
  for (const width of [360, 375, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.route('**/*', (r) => r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><style>${css.join('\n')}body{margin:0}.app-tabs{position:fixed;bottom:0;left:0;right:0;height:56px;background:#000;color:#fff;z-index:30;display:grid;place-items:center;border-top:1px solid #2a2a2a}</style></head><body><div id="root"></div><nav class="app-tabs">Inventory · Receive · More</nav></body></html>`,
    }));
    await page.goto('https://floor-item-detail.test');
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await page.getByText('Selling on', { exact: false }).count(), 0, 'clerk hides selling on');
    assert.equal(await page.getByText('Pricing & cost').count(), 0, 'clerk hides pricing');
    assert.equal(await page.getByText('Ships?').count(), 0, 'clerk hides ships');
    assert.ok(await page.getByRole('button', { name: 'Edit' }).isVisible());
    assert.ok(await page.getByRole('button', { name: 'Set location' }).isVisible());
    assert.ok(await page.getByRole('button', { name: 'Add UPC' }).isVisible());
    await page.screenshot({ path: `/opt/cursor/artifacts/jacob-item-missing-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Add UPC' }).click();
    await page.getByPlaceholder('UPC / EAN').fill('012345678905');
    await page.screenshot({ path: `/opt/cursor/artifacts/jacob-item-upc-edit-${width}.png` });
    await page.getByRole('button', { name: 'Save UPC' }).click();
    await page.waitForFunction(() => window.upcSaved?.p_upc === '012345678905');
    await page.close();
  }

  const admin = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await admin.route('**/*', (r) => r.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><style>${css.join('\n')}body{margin:0}</style></head><body><div id="root"></div></body></html>`,
  }));
  await admin.goto('https://floor-item-detail.test');
  await admin.addScriptTag({ content: outputFiles[0].text });
  await admin.evaluate(() => window.renderAdmin());
  await admin.getByText('Selling on', { exact: false }).waitFor();
  assert.ok(await admin.getByText('Pricing & cost').count() >= 1);
  assert.ok(await admin.getByText('Shipping').count() >= 1);
  const ebayRow = admin.locator('.app-item-channel').filter({ hasText: 'eBay' });
  const box = await ebayRow.evaluate((el) => {
    const right = el.querySelector('.app-item-channel-right');
    const status = right?.querySelector('strong');
    const r = right.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const mid = (er.left + er.right) / 2;
    return {
      rightAlign: Math.abs(r.right - er.right) <= 16,
      statusNotCentered: status ? status.getBoundingClientRect().left > mid - 20 : false,
      text: right?.textContent || '',
    };
  });
  assert.ok(box.rightAlign, `admin channel actions hug the right edge: ${JSON.stringify(box)}`);
  assert.ok(box.statusNotCentered, `Live/Open stay on the right half: ${JSON.stringify(box)}`);
  await admin.screenshot({ path: '/opt/cursor/artifacts/admin-item-390.png', fullPage: true });
  console.log('PASS: clerk item page hides marketplaces/shipping/cost, shows attention UPC/location, and admin keeps selling/pricing with right-aligned rows.');
} finally {
  await browser.close();
}
