/**
 * Ticket tax allocation (0024). Runs against PGlite after migrations.
 *
 *   node --experimental-strip-types scripts/test-ticket-tax.mjs
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const stubPath = path.join(root, "supabase", "tests", "pglite-stub.sql");

async function boot() {
  const db = new PGlite();
  await db.exec(await readFile(stubPath, "utf8"));
  const names = (await readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
  for (const name of names) {
    const sql = await readFile(path.join(migrationsDir, name), "utf8");
    await db.exec(sql.replace(/create extension if not exists pgcrypto;/gi, "-- pglite stub"));
  }
  // allocate_line_taxes is revoked from public; grant to current user for tests.
  await db.exec(`grant execute on function public.allocate_line_taxes(int[], int) to public`);
  return db;
}

const db = await boot();
const store = '00000000-0000-0000-0000-000000000112';
await db.exec(`
 insert into public.stores(id) values ('${store}');
 select set_config('request.jwt.claim.role','service_role',false);
 select set_config('floor.store_id','${store}',false);
 select public.seed_store_settings('${store}','Shipping test');
 insert into public.store_settings(store_id,key,value) values ('${store}','taxRateBps','725'),('${store}','card_fee_bps','250')
 on conflict(store_id,key) do update set value=excluded.value;
`);
const buyer = JSON.stringify({ name:'Test Buyer',email:'buyer@example.com',phone:'9165550100',line1:'123 Test St',city:'Penryn',region:'CA',postal:'95663' });
async function unit(sku, weight, shippable=true, shipping=null) {
 await db.query(`insert into public.sku_ledger(sku,issued_at,store_id) values($1,now(),$2)`,[sku,store]);
 await db.query(`insert into public.units(sku,title,ask_cents,state,store_id,received_at,updated_at,shippable,show_on_website,listing_specs,shipping_cents)
 values($1,'Shipping test',200,'available',$2,now(),now(),$3,true,$4::jsonb,$5)`,[sku,store,shippable,JSON.stringify({weight_lb:weight}),shipping]);
}
async function begin(sku) {
 return (await db.query('select public.begin_shipping_checkout($1,$2,$3::jsonb,0) q',[store,sku,buyer])).rows[0].q;
}
for (const [sku,weight,ship] of [['92001',5,2000],['92002',15,3200],['92003',30,5000]]) {
 await unit(sku,weight);
 const b=await begin(sku);
 assert.equal(b.quote.shipping_cents,ship);
 assert.equal(b.quote.total_cents,220 + ship + Math.round(ship*0.0725));
 assert.ok(new Date(b.expires_at)-Date.now()>590000,'ten-minute hold');
 await assert.rejects(begin(sku),/held_or_unavailable/);
 await db.query('select public.release_shipping_checkout($1,$2)',[store,b.reservation_id]);
 assert.equal((await db.query('select state from public.units where sku=$1',[sku])).rows[0].state,'available');
}
for (const [sku,weight,ship] of [['92004',31,true],['92005',null,true],['92006',2,false]]) {
 await unit(sku,weight,ship);
 await assert.rejects(begin(sku),/held_or_unavailable/);
}
await unit('92007',1,true,0);
const b=await begin('92007');
assert.equal(b.quote.shipping_cents,0);
assert.equal(b.quote.total_cents,220);
let order=(await db.query('select (public.prepare_shipping_payment($1,$2,$3,$4,$5)).*',[store,b.order_id,b.reservation_id,'92007','test-source'])).rows[0];
assert.equal(order.payment_source_id,'test-source');
await assert.rejects(db.query('select public.release_shipping_checkout($1,$2)',[store,b.reservation_id]),/payment_in_progress/);
order=(await db.query('select (public.prepare_shipping_payment($1,$2,$3,$4,$5)).*',[store,b.order_id,b.reservation_id,'92007','new-source'])).rows[0];
assert.equal(order.payment_source_id,'test-source','ambiguous retries reuse token and key');
const complete=()=>db.query('select public.complete_shipping_checkout($1,$2,$3) q',[store,b.order_id,'test-payment']);
const summary=(await complete()).rows[0].q;
assert.equal(summary.total_cents,220);
await complete();
assert.equal((await db.query('select count(*)::int n from public.sales where sku=$1',['92007'])).rows[0].n,1);
assert.equal((await db.query('select status from public.web_orders where id=$1',[b.order_id])).rows[0].status,'paid');
assert.equal((await db.query('select count(*)::int n from public.web_order_emails where order_id=$1',[b.order_id])).rows[0].n,2);
await db.query("update public.web_orders set boxed_at=now() where id=$1",[b.order_id]);
await db.query("update public.web_orders set shipped_at=now(),tracking_number='TEST123' where id=$1",[b.order_id]);
await db.query("update public.web_orders set shipped_at=shipped_at where id=$1",[b.order_id]);
assert.equal((await db.query("select count(*)::int n from public.web_order_emails where order_id=$1 and kind='tracking'",[b.order_id])).rows[0].n,1);
await unit('92008',2);
const expired=await begin('92008');
await db.query("update public.reservations set expires_at=now()-interval '1 second' where id=$1",[expired.reservation_id]);
await assert.rejects(db.query('select public.prepare_shipping_payment($1,$2,$3,$4,$5)',[store,expired.order_id,expired.reservation_id,'92008','source']),/reservation_expired/);
// Changed totals must roll back the whole sale so the payment layer can refund.
await unit('92009',2);
const changed=await begin('92009');
await db.query("update public.store_settings set value='800' where store_id=$1 and key='taxRateBps'",[store]);
await assert.rejects(db.query('select public.complete_shipping_checkout($1,$2,$3)',[store,changed.order_id,'changed-payment']),/quote_changed/);
assert.equal((await db.query('select count(*)::int n from public.sales where sku=$1',['92009'])).rows[0].n,0);
const shipping=await begin('92001');
await db.query('select public.complete_shipping_checkout($1,$2,$3)',[store,shipping.order_id,'shipping-payment']);
const withShipping=(await db.query('select public.ticket_summary($1,$2) q',[store,shipping.reservation_id])).rows[0].q;
assert.equal(withShipping.shipping_cents,2000);
assert.equal(withShipping.total_cents,shipping.quote.total_cents,'receipt equals captured total including shipping');
console.log('PASS shipping tiers, gating, override, atomic holds, release, payment retry, paid order, email queue, tracking, expiry and changed-quote rollback');
await db.close();
