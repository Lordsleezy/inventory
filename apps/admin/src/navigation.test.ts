import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { desktopLanding, parseNavFromLocation, writeNavToLocation } from './navigation.ts';

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

test('Returns is its own page', () => {
  const history = { replaceState: (_: unknown, __: string, next: string) => { location = new URL(next, location); } };
  let location = new URL('https://floor.test/?page=returns');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get location() { return location; }, history } });
  const state = parseNavFromLocation();
  assert.equal(state.page, 'returns');
  writeNavToLocation(state);
  assert.equal(new URLSearchParams(location.search).get('page'), 'returns');
});

test('a bare admin URL opens Home', () => {
  const history = { replaceState: (_: unknown, __: string, next: string) => { location = new URL(next, location); } };
  let location = new URL('https://floor.test/');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get location() { return location; }, history } });
  const state = parseNavFromLocation();
  assert.equal(state.page, 'home');
  writeNavToLocation(state);
  assert.equal(new URLSearchParams(location.search).get('page'), 'home');
});

test('an explicit page deep link stays on that page', () => {
  const history = { replaceState: () => {} };
  let location = new URL('https://floor.test/?page=books');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get location() { return location; }, history } });
  assert.equal(parseNavFromLocation().page, 'books');
});

test('Reports → Sold opens Receipts on the desktop', () => {
  const history = { replaceState: (_: unknown, __: string, next: string) => { location = new URL(next, location); } };
  let location = new URL('https://floor.test/?page=reports&tab=sold');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get location() { return location; }, history } });
  const parsed = parseNavFromLocation();
  assert.equal(parsed.page, 'reports');
  assert.equal(parsed.reportTab, 'sold');
  const state = desktopLanding(parsed);
  assert.equal(state.page, 'receipts');
  writeNavToLocation(state);
  assert.equal(new URLSearchParams(location.search).get('page'), 'receipts');
  assert.equal(new URLSearchParams(location.search).get('tab'), null);
});

test('Reports → Shipping check stays on that tab', () => {
  const history = { replaceState: (_: unknown, __: string, next: string) => { location = new URL(next, location); } };
  let location = new URL('https://floor.test/?page=reports&tab=ship-audit');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get location() { return location; }, history } });
  const state = parseNavFromLocation();
  assert.equal(state.page, 'reports');
  assert.equal(state.reportTab, 'ship-audit');
  writeNavToLocation(state);
  assert.equal(new URLSearchParams(location.search).get('tab'), 'ship-audit');
});

test('Reports → Overhead bookmark opens Overhead (not Profit)', () => {
  const history = { replaceState: (_: unknown, __: string, next: string) => { location = new URL(next, location); } };
  let location = new URL('https://floor.test/?page=reports&tab=overhead');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get location() { return location; }, history } });
  const state = parseNavFromLocation();
  assert.equal(state.page, 'reports');
  assert.equal(state.reportTab, 'overhead');
  writeNavToLocation(state);
  assert.equal(new URLSearchParams(location.search).get('tab'), 'overhead');
});
