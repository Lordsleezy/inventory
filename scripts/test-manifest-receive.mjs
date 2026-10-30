/** Real ReceivePanel in Chromium with mocked catalog and manifest APIs. No live requests. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseManifestLines } from '../apps/admin/src/manifestLines.ts';
const { chromium } = await import(process.env.MANIFEST_PLAYWRIGHT_PATH ? pathToFileURL(process.env.MANIFEST_PLAYWRIGHT_PATH).href : 'playwright');
const manifestLines = parseManifestLines(await readFile(new URL('../apps/admin/test-fixtures/manifest-receive-upcs.csv', import.meta.url), 'utf8'));
function fixtureReference(upc) {
  const matches = manifestLines.filter(line => line.upc_normalized === upc);
  if (!matches.length) return null;
  const defective = matches.filter(line => /SALVAGE|DAMAGED|DEFECTIVE|FOR_PARTS/i.test(line.condition));
  return { retail_cents: matches[0].unit_retail_cents, manifest_name: 'B-Stock 316-unit test manifest', manifest_on: '2026-10-28',
    warnings: defective.length ? [{ manifest_name: 'B-Stock 316-unit test manifest', total_qty: matches.reduce((n, line) => n + line.qty, 0),
      defective_qty: defective.reduce((n, line) => n + line.qty, 0), conditions: [...new Set(defective.map(line => line.condition))] }] : [] };
}
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
          const reference = scenario.useFixtureReference ? scenario.fixtureReferences?.[args?.p_upc] || null : scenario.reference;
          if (scenario.delayed) return new Promise(resolve => { window.__release = () => resolve({ data: reference }); });
          return { data: reference, error: scenario.failed ? { message: 'unavailable' } : null };
        }
        if (name === 'receive_group_lookup') return { data: scenario.groups || [] };
        if (name === 'portal_receive_stock_match') return { data: scenario.stockMatches || [], error: null };
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
      if (String(url).includes('upc-lookup')) return new Response(JSON.stringify(scenario.storeLabel
        ? { store_label: true, true_miss: true, amazon: { found: false }, upcitemdb: { found: false }, merged: { not_found: true } }
        : scenario.miss
        ? { true_miss: true, amazon: { found: false }, upcitemdb: { found: false }, merged: { not_found: true } }
        : { amazon: { found: true }, merged: { title: 'Catalog Brand Model Lamp', brand: 'Catalog Brand', model: 'Catalog Model', category: 'Home' } }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, price: { count: 0 }, fields: [], aspects: [] }), { status: 200 });
    };
    const initialUpc = Object.prototype.hasOwnProperty.call(scenario, 'initialUpc') ? scenario.initialUpc : '096801681609';
    createRoot(document.getElementById('root')).render(<ReceivePanel client={client} storeId="10000000-0000-0000-0000-000000000001" accessToken="test-only" onSaved={() => {}} staffMode={!!scenario.staff} storePhoneMode={!!scenario.staff} appChrome={!!scenario.staff} initialUpc={initialUpc} />);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', external: ['@techstark/opencv-js'], jsx: 'automatic', define: { 'import.meta.env': '{}' },
});
const browser = await chromium.launch({ headless: true, ...(process.env.MANIFEST_CHROMIUM_PATH ? { executablePath: process.env.MANIFEST_CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const ref = { retail_cents: 4999, manifest_name: 'Oct 28 B-Stock load', manifest_on: '2026-10-28', warnings: [] };
async function open(scenario) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => console.error('Receive test page error:', error.message));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('https://floor-receive.test/');
  const fixtureReferences = Object.fromEntries(manifestLines.map(line => [line.upc_normalized, fixtureReference(line.upc_normalized)]));
  await page.evaluate(value => { window.__scenario = value; }, { ...scenario, fixtureReferences });
  await page.addScriptTag({ content: outputFiles[0].text });
  await page.locator(scenario.initialUpc === null ? 'input[placeholder="Scan or type · Enter"]' : 'input[placeholder="0.00"]').waitFor();
  return page;
}
async function scan(upc, scenario) {
  const page = await open({ ...scenario, initialUpc: null });
  const input = page.getByPlaceholder('Scan or type · Enter');
  await input.fill(upc);
  await input.press('Enter');
  await page.locator('input[placeholder="0.00"]').waitFor();
  await page.waitForFunction(code => window.__calls.some(call => call.name === 'portal_manifest_receive_reference' && call.args?.p_upc === code), upc);
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
  for(let i=0;i<10;i++) await staff.getByRole('button',{name:'Increase receive quantity'}).click();
  assert.equal(await staff.locator('.receive-quantity output').innerText(),'11','clerk can set Qty 11 without typing');
  const repeat=await open({staff:true,reference:ref,stockMatches:[{sku:'11500',title:'Example Portable Radio',quantity:8,condition:'New',is_stocked:true,can_convert:false}]});
  await repeat.getByRole('button',{name:'Add to this SKU'}).waitFor();
  await repeat.getByRole('button',{name:'Add to this SKU'}).click();
  await repeat.getByText('SKU 11500 goes to 9 on hand').waitFor();
  assert.equal(await repeat.locator('input[placeholder="Leave blank if unknown"]').count(),0,'stock reuse cannot expose clerk cost');
  console.log('PASS: manifest retail, no-match, catalog miss → photo prompt, all fields isolated, SALVAGE/mixed warnings, manual price, slow/failing sidecar.');
  for (const isStaff of [false, true]) {
    for (const testCase of [
      { upc: '199268613418', price: '$49.99' },
      { upc: '096801681609', price: '$98.99' },
      { upc: '810180401883', price: '$49.99', warning: 'SALVAGE' },
      { upc: '493240033691', price: '$39.99', storeLabel: true },
    ]) {
      const page = await scan(testCase.upc, { staff: isStaff, useFixtureReference: true, storeLabel: testCase.storeLabel });
      await page.locator('.manifest-receive-reference').filter({ hasText: `Manifest retail: ${testCase.price}` }).first().waitFor();
      if (testCase.storeLabel) await page.getByRole('dialog').waitFor();
      assert.equal(await page.locator('input[placeholder="0.00"]').inputValue(), '', `${testCase.upc} does not set the selling price`);
      if (testCase.warning) assert.match(await page.locator('.manifest-receive-reference').first().innerText(), new RegExp(testCase.warning));
      if (isStaff) assert.equal(await page.locator('input[placeholder="Leave blank if unknown"]').count(), 0, 'clerk cost control stays hidden');
      await page.close();
    }
    const noMatch = await scan('999999999999', { staff: isStaff, useFixtureReference: true });
    assert.equal(await noMatch.locator('.manifest-receive-reference').count(), 0, 'unlisted UPC has no manifest retail row');
    await noMatch.close();
  }
  console.log('PASS: clerk/admin scan each manifest UPC (including leading-zero and 49-prefix codes), SALVAGE warning, and no-match; all prior receive-sidecar checks pass.');
} finally { await browser.close(); }
