import test from 'node:test';
import assert from 'node:assert/strict';
import { adjacentReceiveStep, receiveStepPlan } from './receiveSteps.ts';

test('a full catalog hit only asks for the photo, condition, price, and location', () => {
  assert.deepEqual(receiveStepPlan({
    doNotList: false, brand: 'Disney', title: 'Halloween Village', hasCategory: true,
    needsSpecifics: false, hasDims: true, hasStockMatch: false,
  }), ['confirm', 'photo', 'condition', 'price', 'location', 'review']);
});

test('Do not list skips price, category, dims, and stock', () => {
  assert.deepEqual(receiveStepPlan({
    doNotList: true, brand: '', title: '', hasCategory: false,
    needsSpecifics: true, hasDims: false, hasStockMatch: true,
  }), ['confirm', 'photo', 'brand', 'condition', 'location', 'review']);
});

test('a filled size screen still advances to the stock screen', () => {
  const plan = receiveStepPlan({
    doNotList: false, brand: 'Duracell', title: 'Lantern', hasCategory: true,
    needsSpecifics: false, hasDims: true, hasStockMatch: true,
  });
  assert.equal(adjacentReceiveStep(plan, 'dims', 1), 'stock');
});

test('missing listing fields are asked before condition', () => {
  assert.deepEqual(receiveStepPlan({
    doNotList: false, brand: 'Duracell', title: '', hasCategory: false,
    needsSpecifics: false, hasDims: false, hasStockMatch: true,
  }), ['confirm', 'photo', 'title', 'category', 'condition', 'price', 'dims', 'stock', 'location', 'review']);
});
