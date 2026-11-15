import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adjacentReceiveStep, receiveStepPlan } from './receiveSteps.ts';

test('a full catalog hit only asks for the photo, condition, price, and location', () => {
  assert.deepEqual(receiveStepPlan({
    doNotList: false, brand: 'Disney', title: 'Halloween Village',
    hasDims: true, hasStockMatch: false,
  }), ['confirm', 'photo', 'condition', 'price', 'location', 'review']);
});

test('Do not list skips price, dims, and stock, and never asks for eBay', () => {
  assert.deepEqual(receiveStepPlan({
    doNotList: true, brand: '', title: '',
    hasDims: false, hasStockMatch: true,
  }), ['confirm', 'photo', 'brand', 'condition', 'location', 'review']);
});

test('a filled size screen still advances to the stock screen', () => {
  const plan = receiveStepPlan({
    doNotList: false, brand: 'Duracell', title: 'Lantern',
    hasDims: true, hasStockMatch: true,
  });
  assert.equal(adjacentReceiveStep(plan, 'dims', 1), 'stock');
});

test('a missing title is asked, and eBay category never is', () => {
  assert.deepEqual(receiveStepPlan({
    doNotList: false, brand: 'Duracell', title: '',
    hasDims: false, hasStockMatch: true,
  }), ['confirm', 'photo', 'title', 'condition', 'price', 'dims', 'stock', 'location', 'review']);
});

test('New and Open box with a manifest price skip the price screen', () => {
  assert.deepEqual(receiveStepPlan({
    doNotList: false, brand: 'Kohler', title: 'Terzet',
    hasDims: true, hasStockMatch: false, manifestPrice: true,
  }), ['confirm', 'photo', 'condition', 'location', 'review']);
});

test('a used unit still asks for a price when the manifest has one', () => {
  assert.deepEqual(receiveStepPlan({
    doNotList: false, brand: 'Kohler', title: 'Terzet',
    hasDims: true, hasStockMatch: false, manifestPrice: false,
  }), ['confirm', 'photo', 'condition', 'price', 'location', 'review']);
});

test('no barcode opens the Gemini camera, and Defective is the title-only save', async () => {
  const home = await readFile(new URL('./appMode/AppReceive.tsx', import.meta.url), 'utf8');
  assert.match(home, /setPendingUpc\(null\); setEntry\('identify'\); openForm\(false\); \}\}>No barcode<\/button>/);
  assert.match(home, /setEntry\('defective'\); openForm\(false\); \}\}>Defective<\/button>/);
  const scanner = await readFile(new URL('./ReceiveBarcodeScanner.tsx', import.meta.url), 'utf8');
  assert.match(scanner, /mode === 'photo' && onDefective/);
  assert.match(scanner, />Defective</);
  const wizard = await readFile(new URL('./ReceiveWizard.tsx', import.meta.url), 'utf8');
  assert.match(wizard, /onSaveDefective\?\.\(defectiveTitle\.trim\(\)\)/);
  const panel = await readFile(new URL('./ReceivePanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /do_not_list: true, defective: true/);
  assert.match(panel, /p_condition: SCRATCH/);
});

test('adding to an existing SKU asks for a bay before it saves', async () => {
  const wizard = await readFile(new URL('./ReceiveWizard.tsx', import.meta.url), 'utf8');
  assert.match(wizard, /Bay for these items/);
  assert.match(wizard, /Pick a bay for these items/);
  assert.match(wizard, /onAddToStock\(stockMatches\[0\]\.sku, noLocation \? '' : location\)/);
  assert.match(wizard, /!stockBayReady/);
  const panel = await readFile(new URL('./ReceivePanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /p_location: place/);
});

test('eBay category and specifics never get a Receive screen', () => {
  assert.deepEqual(receiveStepPlan({
    doNotList: false, brand: 'Infinity X1', title: 'Flashlight',
    hasDims: true, hasStockMatch: false,
  }), ['confirm', 'photo', 'condition', 'price', 'location', 'review']);
});
