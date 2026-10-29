import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { commitReceive } from './receiveCommit.ts';

test('lost commit response retries the same snapshot with one RPC and no second upload', async () => {
  const cache = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => cache.get(k) || null, setItem: (k: string, v: string) => cache.set(k, v), removeItem: (k: string) => cache.delete(k),
  } });
  const requests: unknown[] = [];
  const client = { rpc: async (name: string, payload: unknown) => {
    assert.equal(name, 'receive_commit'); requests.push(payload);
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

test('a group save preserves one recovery snapshot and replays all eleven SKUs', async () => {
 const cache=new Map<string,string>();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>cache.get(k)||null,setItem:(k:string,v:string)=>cache.set(k,v),removeItem:(k:string)=>cache.delete(k)}});
 const skus=Array.from({length:11},(_,i)=>String(12000+i));let tries=0;
 const request={p_request:'batch',p_fields:{p_quantity:11,p_title:'Portable Radio'},p_photos:['store/receive/actor/batch/a.jpg'],p_extras:{}};
 const client={rpc:async (_:string,payload:unknown)=>{assert.deepEqual(payload,request);return ++tries===1?{error:{message:'response lost'}}:{data:{skus,replayed:true},error:null}}} as unknown as SupabaseClient;
 await assert.rejects(commitReceive(client,'store',request));assert.equal(cache.size,1);
 const result=await commitReceive(client,'store',request);assert.deepEqual(result.skus,skus);assert.equal(cache.size,0);
});
