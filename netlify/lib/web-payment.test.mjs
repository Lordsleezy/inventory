import test from "node:test";
import assert from "node:assert/strict";
import { settleShippingOrder } from "./web-payment.mjs";
import { orderEmail } from "./web-order-email.mjs";
import { webSquareConfig } from "./web-square.mjs";

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
 const names={SQUARE_WEB_APPLICATION_ID:"production-app",SQUARE_WEB_LOCATION_ID:"location",SQUARE_WEB_ACCESS_TOKEN:"token",SQUARE_WEB_STORE_ID:"store"};
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
