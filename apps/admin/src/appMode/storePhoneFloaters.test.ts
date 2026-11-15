import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRemoveStorePhoneControl, type FloaterBox } from './storePhoneFloaters.ts';

const phone = { width: 412, height: 915 };

function box(partial: Partial<FloaterBox> = {}): FloaterBox {
  return { top: 820, right: 400, bottom: 868, left: 336, width: 64, height: 48, ...partial };
}

test('store phone removes the scanner-connecting control in the bottom right', () => {
  assert.equal(shouldRemoveStorePhoneControl({
    position: 'fixed',
    box: box({ left: 230, width: 160, top: 800, bottom: 844 }),
    viewport: phone,
    text: 'Scanner connecting',
    className: '',
    kept: false,
  }), true);
});

test('store phone removes the keyboard popup button', () => {
  assert.equal(shouldRemoveStorePhoneControl({
    position: 'fixed',
    box: box(),
    viewport: phone,
    text: 'Keyboard',
    className: 'receive-keyboard-trigger',
    kept: false,
  }), true);
  assert.equal(shouldRemoveStorePhoneControl({
    position: 'fixed',
    box: box({ top: 760, bottom: 808 }),
    viewport: phone,
    text: '',
    className: '',
    kept: false,
  }), true);
});

test('store phone leaves the tab bar, scanner close, and wide Next button', () => {
  assert.equal(shouldRemoveStorePhoneControl({
    position: 'fixed', box: box({ top: 860, bottom: 915, left: 300, width: 80 }), viewport: phone, text: 'Settings', className: 'app-tabbar', kept: true,
  }), false);
  assert.equal(shouldRemoveStorePhoneControl({
    position: 'absolute', box: box({ top: 820, bottom: 868 }), viewport: phone, text: 'Close', className: '', kept: true,
  }), false);
  assert.equal(shouldRemoveStorePhoneControl({
    position: 'static', box: box({ left: 206, width: 190, top: 820, bottom: 868 }), viewport: phone, text: 'Next', className: 'receive-step-nav', kept: false,
  }), false);
});
