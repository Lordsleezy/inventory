import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dayPart, firstName, pickGreeting } from './homeGreeting.ts';

test('time bands: morning, afternoon, evening', () => {
  assert.equal(dayPart(0), 'morning');
  assert.equal(dayPart(11), 'morning');
  assert.equal(dayPart(12), 'afternoon');
  assert.equal(dayPart(16), 'afternoon');
  assert.equal(dayPart(17), 'evening');
  assert.equal(dayPart(23), 'evening');
});

test('greeting never repeats the previous phrase', () => {
  for (let i = 0; i < 20; i++) {
    const next = pickGreeting('morning', 'Good morning', () => 0);
    assert.notEqual(next, 'Good morning');
  }
  const only = pickGreeting('evening', 'Good evening', () => 0.99);
  assert.notEqual(only, 'Good evening');
});

test('name falls back to the email local-part', () => {
  assert.equal(firstName('Paul Graham', 'pgg124@gmail.com'), 'Paul');
  assert.equal(firstName('', 'jacob.store@employees.floor.local'), 'Jacob');
  assert.equal(firstName(null, 'steve@openboxindustries.com'), 'Steve');
  assert.equal(firstName('  ', ''), 'there');
});
