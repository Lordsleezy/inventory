import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseNavFromLocation, writeNavToLocation } from './navigation.ts';

for (const url of ['https://floor.test/?page=tax', 'https://floor.test/?page=taxes', 'https://floor.test/#tax', 'https://floor.test/?page=reports&tab=sales-tax']) {
  test(`old tax link opens Reports → Sales tax: ${url}`, () => {
    const history = { replaceState: (_: unknown, __: string, next: string) => { location = new URL(next, location); } };
    let location = new URL(url);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { get location() { return location; }, history } });
    const state = parseNavFromLocation();
    assert.equal(state.page, 'reports');
    assert.equal(state.reportTab, 'sales-tax');
    writeNavToLocation(state);
    assert.equal(new URLSearchParams(location.search).get('tab'), 'sales-tax');
  });
}
