import test from "node:test";
import assert from "node:assert/strict";
import { settleShippingOrder } from "./web-payment.mjs";
import { orderEmail } from "./web-order-email.mjs";
import { webSquareConfig } from "./web-square.mjs";
import { cancelAndRefund } from "./web-payment.mjs";
import { fallbackRate, pickRates } from "./shippo.mjs";
import { compare, feedSkus } from "./listing-check.mjs";
import { pickupSweep } from "./web-pickup.mjs";

const order = { id:"order", store_id:"store", payment_attempt_id:"attempt", status:"claimed", payment_source_id:"source", total_cents:220, buyer_email:"buyer@example.com", sku:"92007" };
function fixture(finError) {
  const calls = { charges:[], refunds:[], updates:[] };
  const query = { eq(){ return this; }, neq(){ return this; }, then(resolve){ return Promise.resolve({error:null}).then(resolve); } };
  const sb = { rpc:async()=>({ data:{lines:[{receipt_no:"R-1"}]}, error:finError }), from:()=>({update: v=>{calls.updates.push(v); return query;}}) };
  const deps = { config:{location_id:"production-location"}, deliver:async()=>[], client:{
    paymentsApi:{createPayment:async args=>{calls.charges.push(args);return {result:{payment:{id:"payment",status:"COMPLETED"}}};}},
    refundsApi:{refundPayment:async args=>{calls.refunds.push(args);return {result:{refund:{id:"refund",status:"PENDING"}}};}},
  }};
  return {sb,deps,calls};
}
test("charge uses frozen total, persisted token, and stable attempt key",async()=>{
 const {sb,deps,calls}=fixture(null);
 assert.equal((await settleShippingOrder(sb,order,deps)).statusCode,200);
 assert.equal(calls.charges[0].amountMoney.amount,220n);
 assert.equal(calls.charges[0].sourceId,"source");
 assert.equal(calls.charges[0].idempotencyKey,"web_attempt");
 assert.equal(calls.refunds.length,0);
});
test("already-paid retry does not charge again",async()=>{
 const {sb,deps,calls}=fixture(null);
 await settleShippingOrder(sb,{...order,status:"paid",payment_id:"payment"},deps);
 assert.equal(calls.charges.length,0);
});
test("explicit transaction rejection requests full production refund",async()=>{
 const {sb,deps,calls}=fixture({code:"P0001",message:"reservation_expired"});
 const result=await settleShippingOrder(sb,order,deps);
 assert.equal(JSON.parse(result.body).refunded,true);
 assert.equal(calls.refunds[0].amountMoney.amount,220n);
 assert.equal(calls.updates[0].status,"refunded");
});
test("ambiguous database response never refunds a possibly committed sale",async()=>{
 const {sb,deps,calls}=fixture({message:"network timeout"});
 assert.equal((await settleShippingOrder(sb,order,deps)).statusCode,503);
 assert.equal(calls.refunds.length,0);
});
test("card decline resets only that attempt for a different card",async()=>{
 const {sb,deps,calls}=fixture(null);
 deps.client.paymentsApi.createPayment=async()=>{throw {errors:[{category:"PAYMENT_METHOD_ERROR"}]};};
 assert.equal((await settleShippingOrder(sb,order,deps)).statusCode,400);
 assert.equal(calls.updates[0].payment_source_id,null);
 assert.notEqual(calls.updates[0].payment_attempt_id,"attempt");
});
test("production configuration cannot fall back to register OAuth or sandbox",()=>{
 const names={SQUARE_WEB_ENV:"production",SQUARE_WEB_APPLICATION_ID:"sq0idp-production-app",SQUARE_WEB_LOCATION_ID:"location",SQUARE_WEB_ACCESS_TOKEN:"token",SQUARE_WEB_STORE_ID:"store"};
 Object.assign(process.env,names,{SQUARE_ENVIRONMENT:"sandbox"});
 assert.equal(webSquareConfig("store").sandbox,false);
 assert.throws(()=>webSquareConfig("another-store"),/web_store_not_allowed/);
 delete process.env.SQUARE_WEB_ACCESS_TOKEN;
 assert.throws(()=>webSquareConfig("store"),/missing_SQUARE_WEB_ACCESS_TOKEN/);
 for(const name of Object.keys(names)) delete process.env[name];
});
test("owner and buyer confirmation contain item, buyer, address and charged total; tracking contains number",()=>{
 const payload={...order,title:"Test kettle",buyer_name:"Buyer",ship_line1:"123 Street",shipping_cents:0,tax_cents:15,item_cents:200,checkout_quote:{card_fee_cents:5},tracking_number:"TRACK123"};
 for(const kind of ["owner","confirmation"]){const email=orderEmail(kind,payload);assert.match(email.text,/Test kettle/);assert.match(email.text,/buyer@example.com/);assert.match(email.text,/123 Street/);assert.match(email.text,/Total paid: \$2.20/);}
 assert.match(orderEmail("tracking",payload).text,/TRACK123/);
});
test("sandbox mode needs its own sandbox credentials and never uses production ones",()=>{
 const names={SQUARE_WEB_APPLICATION_ID:"sq0idp-prod",SQUARE_WEB_LOCATION_ID:"prod-loc",SQUARE_WEB_ACCESS_TOKEN:"prod-token",SQUARE_WEB_STORE_ID:"store"};
 Object.assign(process.env,names);
 delete process.env.SQUARE_WEB_ENV;
 assert.throws(()=>webSquareConfig("store"),/missing_SQUARE_WEB_SANDBOX_APPLICATION_ID/);
 Object.assign(process.env,{SQUARE_WEB_SANDBOX_APPLICATION_ID:"sandbox-sq0idb-x",SQUARE_WEB_SANDBOX_LOCATION_ID:"sb-loc",SQUARE_WEB_SANDBOX_ACCESS_TOKEN:"sb"});
 const cfg=webSquareConfig("store");
 assert.equal(cfg.sandbox,true); assert.equal(cfg.location_id,"sb-loc");
 assert.equal(webSquareConfig("store","production").location_id,"prod-loc");
 for(const name of [...Object.keys(names),"SQUARE_WEB_SANDBOX_APPLICATION_ID","SQUARE_WEB_SANDBOX_LOCATION_ID","SQUARE_WEB_SANDBOX_ACCESS_TOKEN"]) delete process.env[name];
});
test("live rates: cheapest first, one per carrier, no zero or foreign-currency rates",()=>{
 const raw=[
  {object_id:"a",amount:"14.10",currency:"USD",provider:"USPS",servicelevel:{name:"Ground Advantage",token:"usps_ground_advantage"},estimated_days:5},
  {object_id:"b",amount:"9.80",currency:"USD",provider:"USPS",servicelevel:{name:"Priority",token:"usps_priority"},estimated_days:2},
  {object_id:"c",amount:"18.00",currency:"USD",provider:"UPS",servicelevel:{name:"Ground",token:"ups_ground"},estimated_days:4},
  {object_id:"d",amount:"0",currency:"USD",provider:"UPS",servicelevel:{name:"Free?"}},
  {object_id:"e",amount:"5",currency:"CAD",provider:"Canada Post",servicelevel:{name:"x"}},
  {object_id:"f",amount:"95.00",currency:"USD",provider:"UPS",servicelevel:{name:"Next Day Air",token:"ups_next_day_air"},estimated_days:1}];
 const r=pickRates(raw);
 assert.deepEqual(r.map(x=>x.id),["b","c"]);
 assert.ok(r.every(x=>x.amount_cents>0));
 assert.equal(r[0].amount_cents,980);
});
test("manual USPS rates use the greater of actual and dimensional weight plus current size fees",()=>{
 const manual_shipping_tiers=[{max_lb:1,cents:1365},{max_lb:2,cents:1980},{max_lb:3,cents:2315},{max_lb:5,cents:2745},{max_lb:10,cents:4085},{max_lb:20,cents:7215},{max_lb:30,cents:12030},{max_lb:40,cents:14790},{max_lb:50,cents:17125},{max_lb:60,cents:19000},{max_lb:70,cents:20430}];
 assert.equal(fallbackRate({manual_shipping_tiers},{weight_lb:4,length_in:4,width_in:4,height_in:4}).amount_cents,2745);
 assert.equal(fallbackRate({manual_shipping_tiers},{weight_lb:0.5,length_in:10,width_in:8,height_in:4}).amount_cents,1365);
 assert.equal(fallbackRate({manual_shipping_tiers},{weight_lb:2,length_in:24,width_in:12,height_in:10}).amount_cents,12480);
 assert.equal(fallbackRate({manual_shipping_tiers},{weight_lb:71,length_in:4,width_in:4,height_in:4}),null);
 assert.equal(fallbackRate({manual_shipping_tiers},{weight_lb:2}),null);
 assert.equal(fallbackRate({manual_shipping_tiers},{weight_lb:2,length_in:80,width_in:30,height_in:25}),null);
});
test("pickup confirmation and reminder carry order number, deadline, address and hours",()=>{
 const o={...order,order_no:"OB-1001",fulfillment:"pickup",title:"Blender",buyer_name:"Pat",pickup_deadline:"2026-10-08T01:30:00Z",item_cents:200,tax_cents:15,total_cents:220,checkout_quote:{}};
 const hours={"0":["10:00","18:00"],"3":["11:00","18:30"]};
 for(const kind of ["confirmation","pickup_reminder"]){
  const m=orderEmail(kind,o,{hours});
  assert.match(m.subject+m.text,/OB-1001/); assert.match(m.text,/3121 Penryn Rd/); assert.match(m.text,/Wednesday: 11 am–6:30 pm/);
  assert.match(m.text,/Monday: Closed/); assert.match(m.text,/October 7/);
 }
 assert.match(orderEmail("owner",o).subject,/PICKUP/);
 assert.match(orderEmail("canceled",{...o,cancel_source:"pickup_expired"}).text,/not picked up by the deadline/);
});
test("cancel & refund: locks, refunds full total with stable key, then voids the sale",async()=>{
 const calls=[];
 const paid={id:"o1",store_id:"store",status:"paid",payment_id:"pay1",total_cents:5400,payment_env:"sandbox"};
 const sb={rpc:async(name,args)=>{calls.push(name);return name==="request_web_order_refund"?{data:paid,error:null}:{data:{...paid,status:"refunded"},error:null};}};
 const refunds=[];
 const client={refundsApi:{refundPayment:async a=>{refunds.push(a);return {result:{refund:{id:"r1",status:"PENDING"}}};}}};
 const r=await cancelAndRefund(sb,"store","o1","admin","customer asked",{client,deliver:async()=>[]});
 assert.equal(r.ok,true); assert.deepEqual(calls,["request_web_order_refund","finish_web_order_refund"]);
 assert.equal(refunds[0].amountMoney.amount,5400n); assert.equal(refunds[0].idempotencyKey,"cancel_o1");
 const failing={refundsApi:{refundPayment:async()=>{throw new Error("down");}}};
 calls.length=0;
 const f=await cancelAndRefund(sb,"store","o1","admin","x",{client:failing,deliver:async()=>[]});
 assert.equal(f.ok,false); assert.deepEqual(calls,["request_web_order_refund"]);
});
test("listing check flags missing, extra and feed-only gaps with reasons",()=>{
 const floor=[{sku:"1",title:"A",reason:null},{sku:"2",title:"B",reason:"List online is turned off for this unit"},{sku:"3",title:"test do not buy",reason:null}];
 const r=compare({floor,view:new Set(["1","3","9"]),site:new Set(["1","9"]),feed:new Set(["1"])});
 const by=s=>r.problems.filter(p=>p.sku===s).map(p=>p.where).sort().join(",");
 assert.equal(by("1"),""); assert.equal(by("2"),"floor_view"); assert.equal(by("3"),"feed,website");
 assert.match(r.problems.find(p=>p.sku==="3"&&p.where==="website").reason,/looks like a test/);
 assert.equal(by("9"),"floor_view,website");
 assert.deepEqual(feedSkus('"id","title"\r\n"10001","A ""q"""\r\n"10002","B"\r\n'),["10001","10002"]);
});
test("pickup sweep: reminder inside 24h, expiry cancels with refund",async()=>{
 const now=new Date("2026-10-06T20:00:00Z");
 const rows={due:[{id:"r1",store_id:"s",sku:"1",order_no:"OB-1",pickup_deadline:"2026-10-07T01:30:00Z"}],late:[{id:"l1",store_id:"s",order_no:"OB-2"}],stuck:[]};
 const queue=["due","late","stuck"]; const upserts=[];
 const chain=(name)=>{const q={select(){return q},eq(){return q},is(){return q},gt(){return q},lte(){return q},lt(){return q},not(){return q},maybeSingle:async()=>({data:{title:"Lamp"}}),
  update(){return {eq:async()=>({error:null})}},upsert:async(v)=>{upserts.push(v);return {error:null}},
  then(res){return Promise.resolve({data:rows[queue.shift()],error:null}).then(res);}};return q;};
 const sb={from:chain};
 const canceled=[];
 const out=await pickupSweep(sb,{now,cancel:async(_s,store,id,source)=>{canceled.push([id,source]);return {ok:true};},deliver:async()=>[]});
 assert.deepEqual(out.reminded,["OB-1"]); assert.deepEqual(out.expired,["OB-2"]);
 assert.equal(upserts[0].kind,"pickup_reminder"); assert.equal(upserts[0].payload.title,"Lamp");
 assert.deepEqual(canceled,[["l1","pickup_expired"]]);
});
