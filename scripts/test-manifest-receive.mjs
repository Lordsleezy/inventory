/** Real ReceivePanel in Chromium with mocked catalog and manifest APIs. No live requests. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.MANIFEST_PLAYWRIGHT_PATH ? pathToFileURL(process.env.MANIFEST_PLAYWRIGHT_PATH).href : 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ReceivePanel } from './apps/admin/src/ReceivePanel';
    const scenario = window.__scenario;
    window.__calls = [];
    const client = {
      rpc: async (name, args) => {
        window.__calls.push({ name, args });
        if (name === 'portal_manifest_receive_reference') {
          if (scenario.delayed) return new Promise(resolve => { window.__release = () => resolve({ data: scenario.reference }); });
          return { data: scenario.reference, error: scenario.failed ? { message: 'unavailable' } : null };
        }
        if (name === 'portal_receive_options' || name === 'staff_receive_options') return { data: { next_sku: '10001', categories: ['Home'], conditions: ['New'], test_statuses: ['untested'] } };
        return { data: null };
      },
      from: table => {
        window.__calls.push({ table });
        const chain = new Proxy({}, { get: (_, key) => key === 'then' ? resolve => resolve({ data: [] }) : () => chain });
        return chain;
      },
    };
    window.fetch = async (url, options) => {
      window.__calls.push({ url, body: JSON.parse(options?.body || '{}') });
      if (String(url).includes('upc-lookup')) return new Response(JSON.stringify(scenario.miss
        ? { true_miss: true, amazon: { found: false }, upcitemdb: { found: false }, merged: { not_found: true } }
        : { amazon: { found: true }, merged: { title: 'Catalog Brand Model Lamp', brand: 'Catalog Brand', model: 'Catalog Model', category: 'Home' } }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, price: { count: 0 }, fields: [], aspects: [] }), { status: 200 });
    };
    createRoot(document.getElementById('root')).render(<ReceivePanel client={client} storeId="10000000-0000-0000-0000-000000000001" accessToken="test-only" onSaved={() => {}} staffMode={!!scenario.staff} storePhoneMode={!!scenario.staff} appChrome={!!scenario.staff} initialUpc="096801681609" />);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', external: ['@techstark/opencv-js'], jsx: 'automatic', define: { 'import.meta.env': '{}' },
});
const browser = await chromium.launch({ headless: true, ...(process.env.MANIFEST_CHROMIUM_PATH ? { executablePath: process.env.MANIFEST_CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const ref = { retail_cents: 4999, manifest_name: 'Oct 28 B-Stock load', manifest_on: '2026-10-28', warnings: [] };
async function open(scenario) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => console.error('Receive test page error:', error.message));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('https://floor-receive.test/');
  await page.evaluate(value => { window.__scenario = value; }, scenario);
  await page.addScriptTag({ content: outputFiles[0].text });
  await page.locator('input[placeholder="0.00"]').waitFor();
  return page;
}
async function fields(page) {
  return page.locator('input:not([type="file"]), textarea, select').evaluateAll(elements => elements.map(e => ({ type: e.type, value: e.value, checked: e.checked })));
}
try {
  const baseline = await open({ reference: null });
  const baselineFields = await fields(baseline);
  assert.equal(await baseline.getByText('Manifest retail:', { exact: false }).count(), 0);
  const matched = await open({ reference: ref });
  await matched.locator('.manifest-receive-reference').filter({ hasText: 'Manifest retail: $49.99' }).first().waitFor();
  assert.deepEqual(await fields(matched), baselineFields, 'manifest reference cannot change any receive fields, prices, or cost defaults');
  assert.equal(await matched.locator('input[placeholder="0.00"]').inputValue(), '');
  await matched.locator('input[placeholder="0.00"]').fill('17.50');
  assert.equal(await matched.locator('input[placeholder="0.00"]').inputValue(), '17.50');
  assert.match(await matched.locator('.manifest-receive-reference').first().innerText(), /from Oct 28 B-Stock load/);
  const miss = await open({ reference: { ...ref, warnings: [{ manifest_name: ref.manifest_name, total_qty: 2, defective_qty: 2, conditions: ['SALVAGE'] }] }, miss: true });
  await miss.getByRole('dialog').waitFor();
  await miss.getByRole('button', { name: 'Yes — take photo' }).waitFor();
  assert.match(await miss.locator('.manifest-receive-reference').first().innerText(), /Manifest warns an item with this UPC is defective \(SALVAGE\)/);
  const missBaseline = await open({ reference: null, miss: true });
  await missBaseline.getByRole('dialog').waitFor();
  assert.deepEqual(await fields(miss), await fields(missBaseline), 'catalog miss remains a miss and no manifest item data is copied');
  const mixed = await open({ reference: { ...ref, warnings: [{ manifest_name: ref.manifest_name, total_qty: 14, defective_qty: 2, conditions: ['SALVAGE'] }] } });
  await mixed.getByText('2 of 14 units of this UPC on the manifest are marked SALVAGE. Check this one.', { exact: true }).first().waitFor();
  assert.deepEqual(await fields(mixed), baselineFields, 'warning does not select condition or alter price/cost');
  const slow = await open({ reference: ref, delayed: true });
  assert.equal(await slow.locator('input[placeholder="0.00"]').inputValue(), '', 'receive form does not wait for manifest lookup');
  await slow.locator('input[placeholder="0.00"]').fill('29.95');
  await slow.evaluate(() => window.__release());
  await slow.locator('.manifest-receive-reference').filter({ hasText: 'Manifest retail: $49.99' }).first().waitFor();
  assert.equal(await slow.locator('input[placeholder="0.00"]').inputValue(), '29.95', 'late manifest response does not overwrite typed price');
  const failed = await open({ reference: null, failed: true });
  await failed.getByText('Manifest reference unavailable. Keep receiving or retry the scan.', { exact: true }).first().waitFor();
  assert.deepEqual(await fields(failed), baselineFields);
  const staff = await open({ staff: true, reference: { ...ref, warnings: [{ manifest_name: ref.manifest_name, total_qty: 14, defective_qty: 2, conditions: ['SALVAGE'] }] } });
  await staff.locator('.manifest-receive-reference').filter({ hasText: 'Manifest retail: $49.99' }).first().waitFor();
  assert.match(await staff.locator('.manifest-receive-reference').first().innerText(), /2 of 14/);
  assert.equal(await staff.locator('input[placeholder="0.00"]').inputValue(), '');
  assert.equal(await staff.locator('input[placeholder="Leave blank if unknown"]').count(), 0, 'clerk cost control stays hidden');
  assert.equal(await staff.evaluate(() => window.__calls.filter(call => call.table === 'store_manifests').length), 0, 'clerk needs only the narrow reference RPC');
  console.log('PASS: manifest retail, no-match, catalog miss → photo prompt, all fields isolated, SALVAGE/mixed warnings, manual price, slow/failing sidecar.');
} finally { await browser.close(); }
