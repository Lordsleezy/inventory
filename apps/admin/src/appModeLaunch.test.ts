import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// isAppMode.ts uses extensionless imports, so bundle it once for node's test runner.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./appMode/isAppMode.ts', import.meta.url))],
  bundle: true, format: 'esm', write: false, platform: 'neutral',
});
const { isStandaloneApp } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`) as typeof import('./appMode/isAppMode');

type Env = { url?: string; media?: string[]; standalone?: boolean; ua?: string; stored?: string };

function setup({ url = 'https://admin.floor.test/', media = [], standalone, ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', stored }: Env) {
  const store = new Map<string, string>(stored ? [['floor_app_mode', stored]] : []);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: new URL(url),
    matchMedia: (q: string) => ({ matches: media.some(m => q.includes(m)) }),
    navigator: { standalone, userAgent: ua },
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: ua, standalone, platform: 'Linux', maxTouchPoints: 0 } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { getAttribute: () => null, classList: { contains: () => false } } } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k),
  } });
  return store;
}

test('desktop Chrome tab: desktop layout', () => { setup({}); assert.equal(isStandaloneApp(), false); });
test('stale saved app flag no longer forces the phone shell, and is cleared', () => {
  const store = setup({ stored: '1' });
  assert.equal(isStandaloneApp(), false);
  assert.equal(store.has('floor_app_mode'), false);
});
test('URL params ?app=1 / ?source=pwa alone do not switch layout', () => {
  setup({ url: 'https://admin.floor.test/?app=1' }); assert.equal(isStandaloneApp(), false);
  setup({ url: 'https://admin.floor.test/?source=pwa' }); assert.equal(isStandaloneApp(), false);
});
test('Android phone Chrome tab (narrow, touch): desktop layout', () => {
  setup({ media: ['max-width: 900px', 'pointer: coarse'], ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130 Mobile' });
  assert.equal(isStandaloneApp(), false);
});
test('iPhone Safari tab: desktop layout', () => {
  setup({ media: ['max-width: 900px', 'pointer: coarse'], ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' });
  assert.equal(isStandaloneApp(), false);
});
test('installed PWA (display-mode standalone): phone shell', () => {
  setup({ media: ['display-mode: standalone'] }); assert.equal(isStandaloneApp(), true);
});
test('iOS home-screen app (navigator.standalone): phone shell', () => {
  setup({ standalone: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }); assert.equal(isStandaloneApp(), true);
});
test('store phone kiosk shell: phone shell', () => {
  setup({ url: 'https://admin.floor.test/?kiosk=1' }); assert.equal(isStandaloneApp(), true);
});
