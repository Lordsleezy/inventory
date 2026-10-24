import test from 'node:test';
import assert from 'node:assert/strict';
import {safeNetlifyOutput} from './netlify-output.mjs';
test('CLI transport diagnostics never print serialized authorization values',()=>{
 const raw='{"headers":{"Authorization":"Bearer sample-private-value"},"access_token":"sample-other-value"} nfp_example_only';
 const safe=safeNetlifyOutput(raw);
 assert.doesNotMatch(safe,/sample-private-value|sample-other-value|nfp_example_only/);
 assert.match(safe,/REDACTED/);
 assert.equal(safeNetlifyOutput('92 functions deployed'),'92 functions deployed');
});
