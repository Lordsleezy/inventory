import fs from 'node:fs';import assert from 'node:assert/strict';import{PGlite}from'@electric-sql/pglite';import{replayMigrationPaths}from'./lib/replay-migrations.mjs';
const db=new PGlite();try{
await db.exec(fs.readFileSync('supabase/tests/pglite-stub.sql','utf8'));for(const f of replayMigrationPaths(process.cwd()))await db.exec(fs.readFileSync(f,'utf8').replace(/create extension if not exists pgcrypto;/gi,''));
await db.exec(`alter table auth.users add column if not exists email text;insert into auth.users(id) values('20000000-0000-0000-0000-000000000001');insert into stores(id) values('10000000-0000-0000-0000-000000000001');insert into staff(user_id,store_id,display_name,role)values('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Owner','owner');insert into portal_admins(user_id,store_id)values('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');select seed_store_settings('10000000-0000-0000-0000-000000000001','Stock');select set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);select set_config('request.jwt.claim.role','authenticated',false);insert into storage.objects(bucket_id,name)values('unit-photos','10000000-0000-0000-0000-000000000001/receive/20000000-0000-0000-0000-000000000001/30000000-0000-0000-0000-000000000001/actual.jpg');`);
const q=async(sql,args=[])=> (await db.query(sql,args)).rows;
let result=(await q(`select receive_commit('30000000-0000-0000-0000-000000000001','{"p_quantity":12,"p_brand":"Radio","p_title":"Portable Radio","p_condition":"New","p_ask_cents":1000,"p_cost_cents":200,"p_upc":"096801681609"}',array['10000000-0000-0000-0000-000000000001/receive/20000000-0000-0000-0000-000000000001/30000000-0000-0000-0000-000000000001/actual.jpg'],'{}') result`))[0].result;console.log('receive',result);const sku=result.skus[0];assert.equal(result.skus.length,1);assert.equal((await q('select qty_on_hand,stocked from units where sku=$1',[sku]))[0].qty_on_hand,12);
await db.exec(`insert into store_settings(store_id,key,value)values('10000000-0000-0000-0000-000000000001','taxRateBps','0') on conflict(store_id,key)do update set value=excluded.value`);
const sale=(await q(`select finalize_ticket(p_ticket_id=>'40000000-0000-0000-0000-000000000001',p_lines=>$1::jsonb,p_payment_method=>'cash',p_payment_id=>'manual:stock',p_cash_cents=>3000,p_card_cents=>0) r`,[JSON.stringify([{sku,price_cents:1000,qty:3}])]))[0].r;console.log('sale',sale);assert.equal((await q('select qty_on_hand from units where sku=$1',[sku]))[0].qty_on_hand,9);const ledger=(await q('select id,profit_cents,cost_cents from sale_ledger where sku=$1',[sku]))[0];console.log('ledger',ledger);assert.equal(ledger.cost_cents,600);
const ret=(await q(`select stock_return($1,1,'returned in original condition','50000000-0000-0000-0000-000000000001') r`,[ledger.id]))[0].r;console.log('return',ret);assert.equal((await q('select qty_on_hand from units where sku=$1',[sku]))[0].qty_on_hand,10);

assert.equal((await q('select profit_cents from sale_ledger where id=$1',[ledger.id]))[0].profit_cents,1600,'partial return nets revenue and recovered cost');
assert.equal((await q("select expected_cents from jsonb_to_recordset(portal_withdrawal_reconciliation()) as r(source text,expected_cents bigint) where source='safe'"))[0].expected_cents,2000,'cash refund deducted once');
const period=(await q("select portal_books_ensure_period('month',date_trunc('month',now())::date,(date_trunc('month',now())+interval '1 month - 1 day')::date) id"))[0].id;
const books=(await q('select portal_books_report($1) r',[period]))[0].r;assert.equal(books.inventory_bought.find(x=>x.sku===sku).quantity,12);assert.equal(books.inventory_bought.find(x=>x.sku===sku).cost_cents,2400);
const before=(await q('select qty_on_hand from units where sku=$1',[sku]))[0].qty_on_hand;
await assert.rejects(q(`select finalize_ticket(p_ticket_id=>'40000000-0000-0000-0000-000000000099',p_lines=>$1::jsonb,p_payment_method=>'cash',p_payment_id=>'manual:oversell',p_cash_cents=>99000,p_card_cents=>0)`,[JSON.stringify([{sku,price_cents:1000,qty:99}])]),/insufficient_qty/);assert.equal((await q('select qty_on_hand from units where sku=$1',[sku]))[0].qty_on_hand,before);
console.log('info',(await q('select stock_info($1) r',[sku]))[0].r);
console.log('give',(await q(`select stock_action($1,'giveaway',2,'Donation','60000000-0000-0000-0000-000000000001',null) r`,[sku]))[0].r);
console.log('defective',(await q(`select stock_action($1,'defective',1,'Pulled damaged piece','70000000-0000-0000-0000-000000000001',null) r`,[sku]))[0].r);

let balance=(await q('select qty_on_hand from units where sku=$1',[sku]))[0].qty_on_hand;
assert.equal(balance,7);assert.equal((await q('select sum(delta)::int n from stock_movements where sku=$1',[sku]))[0].n,balance);
assert.equal((await q("select amount_cents from portal_expenses where category='Giveaways'"))[0].amount_cents,400);
await assert.rejects(q(`select stock_action($1,'adjust_set',5,'','80000000-0000-0000-0000-000000000001',null)`,[sku]),/reason_required/);
await q(`select stock_action($1,'adjust_delta',-1,'lost: count checked','80000000-0000-0000-0000-000000000002',null)`,[sku]);assert.equal((await q('select qty_on_hand from units where sku=$1',[sku]))[0].qty_on_hand,6);
await q(`select stock_action($1,'added',2,'new stock','80000000-0000-0000-0000-000000000003',400)`,[sku]);assert.equal((await q('select acquisition_cost_cents from units where sku=$1',[sku]))[0].acquisition_cost_cents,250);
assert.equal((await q('select stock_unit_cost_cents from sales where id=$1',[ledger.id]))[0].stock_unit_cost_cents,200);
assert.equal((await q('select cost_cents from sale_ledger where id=$1',[ledger.id]))[0].cost_cents,400,'old sale cost unaffected by new average');
const add={p_quantity:2,p_title:'Portable Radio',p_condition:'New',p_upc:'096801681609',p_ask_cents:1000};
const added=(await q(`select receive_commit('90000000-0000-0000-0000-000000000001',$1::jsonb,'{}',$2::jsonb) r`,[JSON.stringify(add),JSON.stringify({target_sku:sku})]))[0].r;assert.equal(added.on_hand,10);
const replay=(await q(`select receive_commit('90000000-0000-0000-0000-000000000001',$1::jsonb,'{}',$2::jsonb) r`,[JSON.stringify(add),JSON.stringify({target_sku:sku})]))[0].r;assert.equal(replay.on_hand,10);
// The migration itself must not merge anything, and sold-history units are not candidates.
assert.equal((await q('select count(*)::int n from stock_sku_aliases'))[0].n,0);

// Website backend quantity checkout uses the same stock and receipt math.
await q(`update units set show_on_website=true,model='Portable Radio',category='Electronics',listing_body='Portable radio',package_length_in=4,package_width_in=3,package_height_in=2,package_weight_lb=1 where sku=$1`,[sku]);
console.log('storefront',(await q('select count(*)::int n from storefront_items where sku=$1',[sku]))[0]);
await q("select set_config('request.jwt.claim.role','service_role',false)");
const web=(await q(`select begin_online_checkout('10000000-0000-0000-0000-000000000001',$1,'{"name":"Test Buyer","email":"buyer@example.test","phone":"5551234567"}','pickup',null,null,0,2) r`,[sku]))[0].r;
assert.equal(web.quantity,2);assert.equal(web.item_cents,2000);
const completed=(await q(`select complete_shipping_checkout('10000000-0000-0000-0000-000000000001',$1,'test:quantity-payment') r`,[web.order_id]))[0].r;console.log('web completed',completed);
assert.equal((await q('select qty_on_hand from units where sku=$1',[sku]))[0].qty_on_hand,8);
await q("select set_config('request.jwt.claim.role','authenticated',false)");

// Reviewed duplicate merges retire old SKUs as aliases, never touching sold history.
const duplicateSkus=[];
for(let i=1;i<=2;i++){const req='a0000000-0000-0000-0000-00000000000'+i;const photo='10000000-0000-0000-0000-000000000001/receive/20000000-0000-0000-0000-000000000001/'+req+'/actual.jpg';await q("insert into storage.objects(bucket_id,name)values('unit-photos',$1)",[photo]);const r=(await q("select receive_commit($1::uuid,$2::jsonb,$3::text[],'{}') r",[req,JSON.stringify({p_quantity:1,p_title:'Duplicate Test Radio',p_brand:'Example',p_condition:'New',p_upc:'030772199381',p_ask_cents:1000,p_cost_cents:i*200-100}),[photo]]))[0].r;duplicateSkus.push(r.skus[0]);}
const candidates=(await q('select stock_merge_candidates() r'))[0].r;const candidate=candidates.find(x=>x.skus.includes(duplicateSkus[0]));assert.equal(candidate.quantity,2);assert.ok(!candidates.some(x=>x.skus.includes(sku)),'sold-history SKU never merges');
const merged=(await q(`select stock_merge($1,'b0000000-0000-0000-0000-000000000001') r`,[candidate.skus]))[0].r;assert.equal(merged.sku,duplicateSkus[0]);assert.equal((await q('select stock_resolve_sku($1) sku',[duplicateSkus[1]]))[0].sku,duplicateSkus[0]);assert.equal((await q('select acquisition_cost_cents from units where sku=$1',[duplicateSkus[0]]))[0].acquisition_cost_cents,200);
assert.equal((await q('select count(*)::int n from sales where sku=$1',[sku]))[0].n,2);
assert.ok((await q('select count(*)::int n from units u where qty_on_hand<>(select coalesce(sum(delta),0) from stock_movements m where m.store_id=u.store_id and m.sku=u.sku)'))[0].n===0,'every unit balances to movements');
console.log('merge',merged);
console.log('PASS: stocked receive, qty sale, partial return, money totals, Books quantity, movements, giveaway, defect pull, adjustments, cost snapshots and recovery.');
}catch(e){console.error(JSON.stringify({error:e.message,where:e.where,detail:e.detail}));process.exitCode=1}finally{await db.close()}


