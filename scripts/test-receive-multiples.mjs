import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
const {chromium}=await import(process.env.MANIFEST_PLAYWRIGHT_PATH?pathToFileURL(process.env.MANIFEST_PLAYWRIGHT_PATH).href:'playwright');
const {outputFiles}=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ReceiveQuantity} from './apps/admin/src/ReceiveQuantity';import {ReceiveGroupRow} from './apps/admin/src/ReceiveGroupRow';
const client={rpc:async(name,args)=>{window.calls.push({name,args});return {data:8}}};
function Test(){const [q,setQ]=useState('1');return <><ReceiveQuantity value={q} onChange={setQ}/><ReceiveGroupRow client={client} admin={window.admin} money={n=>'$'+n/100} onOpen={sku=>window.opened=sku} onChanged={()=>window.changed=true} item={{sku:'10001',title:'Portable Radio',condition:'New',ask_cents:2000,group_id:'group',group_total:11,group_in_stock:8,group_skus:['10001','10002'],group_members:[{sku:'10001',title:'Portable Radio',condition:'New',state:'available',ask_cents:2000},{sku:'10002',title:'Portable Radio',condition:'New',state:'sold',ask_cents:null,sold_price_cents:null}]}}/></>}
window.calls=[];createRoot(document.getElementById('root')).render(<Test/>);
`},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic'});
const browser=await chromium.launch({headless:true,...(process.env.MANIFEST_CHROMIUM_PATH?{executablePath:process.env.MANIFEST_CHROMIUM_PATH}:{}),args:['--no-sandbox']});
try{
 for(const admin of [false,true]){
 const page=await browser.newPage({viewport:{width:390,height:844}});await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('https://floor-group.test');await page.evaluate(v=>window.admin=v,admin);await page.addScriptTag({content:outputFiles[0].text});
 const plus=page.getByRole('button',{name:'Increase receive quantity'});for(let i=0;i<10;i++)await plus.click();assert.equal(await page.locator('output').innerText(),'11');assert.equal(await page.locator('.receive-quantity input').count(),0);
 await page.getByText('Portable Radio ×11 (8 in stock)',{exact:true}).click();await page.getByRole('button',{name:'SKU 10001',exact:false}).click();assert.equal(await page.evaluate(()=>window.opened),'10001');
 assert.equal(await page.getByRole('button',{name:'Apply price / details',exact:false}).count(),admin?1:0);
 if(admin){await page.getByRole('button',{name:'Apply price / details',exact:false}).click();await page.getByLabel('Price ($)',{exact:true}).fill('24.99');page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Apply to group',exact:true}).click();await page.waitForFunction(()=>window.changed);assert.deepEqual(await page.evaluate(()=>window.calls.find(c=>c.name==='receive_group_apply').args),{p_group:'group',p_patch:{ask_cents:2499}})}
 await page.close();}
 console.log('PASS: tap-only Qty 11, repeat-UPC group choice, expand/open individual SKU, clerk controls hidden, deliberate admin group edit.');
}finally{await browser.close()}
