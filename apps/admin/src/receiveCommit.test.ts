import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { commitReceive, isDefiniteRejection, ReceiveRejectedError } from './receiveCommit.ts';

test('lost commit response retries the same snapshot with one RPC and no second upload', async () => {
  const cache = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => cache.get(k) || null, setItem: (k: string, v: string) => cache.set(k, v), removeItem: (k: string) => cache.delete(k),
  } });
  const requests: unknown[] = [];
  const client = { rpc: async (name: string, payload: unknown) => {
    assert.equal(name, 'portal_receive_stocked_commit'); requests.push(payload);
    return requests.length === 1 ? { data: null, error: { message: 'network lost after commit' } }
      : { data: { skus: ['54001'], server_ms: 12, replayed: true }, error: null };
  } } as unknown as SupabaseClient;
  const original = { p_request: 'same-request', p_fields: { p_title: 'Actual photo item' }, p_photos: ['store/receive/actor/same-request/unit.jpg'], p_extras: { location: null } };
  await assert.rejects(commitReceive(client, 'store', original), /Save is not confirmed/);
  assert.equal(cache.size, 1);
  const result = await commitReceive(client, 'store', { ...original, p_fields: { p_title: 'changed after timeout' } });
  assert.equal(result.replayed, true); assert.equal(cache.size, 0);
  assert.deepEqual(requests, [original, original]);
});

test('an interrupted legacy item never blocks a different receive request', async () => {
  const cache = new Map<string,string>();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>cache.get(k)||null,setItem:(k:string,v:string)=>cache.set(k,v),removeItem:(k:string)=>cache.delete(k)}});
  const old = {p_request:'fridge',p_fields:{p_title:'Fridge'},p_photos:['store/receive/actor/fridge/a.jpg'],p_extras:{}};
  cache.set('floor:pending-receive:store',JSON.stringify(old));
  const next={...old,p_request:'next',p_fields:{p_title:'Next item'}};
  const client={rpc:async (_:string,payload:unknown)=>{assert.deepEqual(payload,next);return {data:{skus:['99873']},error:null}}} as unknown as SupabaseClient;
  await commitReceive(client,'store',next);
  assert.deepEqual(JSON.parse(cache.get('floor:pending-receive:store:fridge')!),old);
  assert.equal(cache.size,1);
});

test('a multi-quantity stock save preserves one recovery snapshot and replays one SKU', async () => {
 const cache=new Map<string,string>();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>cache.get(k)||null,setItem:(k:string,v:string)=>cache.set(k,v),removeItem:(k:string)=>cache.delete(k)}});
 const skus=['12000'];let tries=0;
 const request={p_request:'batch',p_fields:{p_quantity:11,p_title:'Portable Radio'},p_photos:['store/receive/actor/batch/a.jpg'],p_extras:{}};
 const client={rpc:async (_:string,payload:unknown)=>{assert.deepEqual(payload,request);return ++tries===1?{error:{message:'response lost'}}:{data:{skus,replayed:true},error:null}}} as unknown as SupabaseClient;
 await assert.rejects(commitReceive(client,'store',request));assert.equal(cache.size,1);
 const result=await commitReceive(client,'store',request);assert.deepEqual(result.skus,skus);assert.equal(cache.size,0);
});

test('a server refusal (sku_exhausted) saves nothing, drops the snapshot and sends the corrected form next time', async () => {
  const cache = new Map<string,string>();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>cache.get(k)||null,setItem:(k:string,v:string)=>cache.set(k,v),removeItem:(k:string)=>cache.delete(k)}});
  const sent: unknown[] = [];
  const client = { rpc: async (_: string, payload: unknown) => { sent.push(payload);
    return sent.length === 1 ? { data: null, error: { message: 'sku_exhausted', code: '22023' } } : { data: { skus: ['12001'] }, error: null }; } } as unknown as SupabaseClient;
  const first = { p_request: 'curtain', p_fields: { p_title: 'Curtain' }, p_photos: ['store/receive/actor/curtain/a.jpg'], p_extras: {} };
  await assert.rejects(commitReceive(client, 'store', first), (e: Error) => e instanceof ReceiveRejectedError && /Nothing was saved/.test(e.message) && !/Recover interrupted save/.test(e.message));
  assert.equal(cache.size, 0, 'no stuck "interrupted save" record after a definite refusal');
  const corrected = { ...first, p_fields: { p_title: 'Curtain, corrected' } };
  await commitReceive(client, 'store', corrected);
  assert.deepEqual(sent[1], corrected);
});

test('Recover keeps the record on a refusal and succeeds once the server is fixed', async () => {
  const cache = new Map<string,string>();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>cache.get(k)||null,setItem:(k:string,v:string)=>cache.set(k,v),removeItem:(k:string)=>cache.delete(k)}});
  let fixed = false;
  const client = { rpc: async () => fixed ? { data: { skus: ['12002'] }, error: null } : { data: null, error: { message: 'sku_exhausted', code: '22023' } } } as unknown as SupabaseClient;
  const pending = { p_request: 'stuck', p_fields: { p_title: 'Curtain' }, p_photos: ['store/receive/actor/stuck/a.jpg'], p_extras: {} };
  await assert.rejects(commitReceive(client, 'store', pending, { keepOnReject: true }), ReceiveRejectedError);
  assert.equal(cache.size, 1);
  fixed = true;
  assert.deepEqual((await commitReceive(client, 'store', pending, { keepOnReject: true })).skus, ['12002']);
  assert.equal(cache.size, 0);
});

test('only SQLSTATE / PostgREST codes count as definite refusals', () => {
  assert.equal(isDefiniteRejection({ code: '22023' }), true);
  assert.equal(isDefiniteRejection({ code: '57014' }), true);
  assert.equal(isDefiniteRejection({ code: 'PGRST301' }), true);
  assert.equal(isDefiniteRejection({ code: '' }), false);
  assert.equal(isDefiniteRejection(undefined), false);
});
