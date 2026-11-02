import assert from 'node:assert/strict';
import { dollarsText, mercariFeeDefault, mercariPayoutDefault, mercariProfit } from './mercariMath.ts';

assert.equal(mercariFeeDefault(5800, 0), 580);
assert.equal(mercariFeeDefault(5800, 1000), 680);
assert.equal(mercariFeeDefault(null, 0), null);
assert.equal(mercariFeeDefault(1000, null), null);

assert.equal(mercariPayoutDefault(5800, 1000, 680, 800), 5320);
assert.equal(mercariPayoutDefault(5800, 0, 580, 0), 5220);
assert.equal(mercariPayoutDefault(100, 0, 50, 100), 0);
assert.equal(mercariPayoutDefault(null, 0, 0, 0), null);

assert.equal(dollarsText(2499), '24.99');
assert.equal(mercariProfit(5220, 900), 4320);
assert.equal(mercariProfit(5220, null), null);

console.log('mercariMath.test.ts: ok');
