import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.MANIFEST_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.MANIFEST_PLAYWRIGHT_PATH).href : 'playwright');
const css = await Promise.all([
  readFile('apps/admin/src/style.css', 'utf8'),
  readFile('apps/admin/src/appMode/appMode.css', 'utf8'),
]);
const { outputFiles } = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{UnitEditDrawer}from'./apps/admin/src/UnitEditDrawer';
const gaps=['specifics'];window.nextGaps=[];
const client={rpc:async(name,args)=>{window.rpcCalls.push({name,args});if(name==='portal_receive_options')return{data:{conditions:['New','Open box'],test_statuses:[]}};if(name==='portal_unit_readiness_gaps')return{data:window.nextGaps};if(name==='portal_update_unit')return{data:{sku:'99871',upc:'810205870267',brand:'APOTHEKE',model:'2 Wick',title:'APOTHEKE candle',description:'',ask_cents:1900,cost_cents:400,condition:'New',test_status:'',notes:'',package_length_in:2,package_width_in:2,package_height_in:4,package_weight_lb:4,fulfillment_override:null}};if(name==='portal_unit_ebay_specifics')return{data:{can_pick_category:true}};return{data:null}}};client.auth={getSession:async()=>({data:{session:{access_token:'test'}}})};client.storage={from:()=>({createSignedUrls:async()=>({data:[]}),upload:async()=>({}),remove:async()=>({})})};
const unit={sku:'99871',upc:'810205870267',brand:'APOTHEKE',model:'2 Wick',title:'APOTHEKE 2 Wick Large White Vetiver Jar Candle 16oz',listing_body:'',ask_cents:1900,acquisition_cost_cents:400,condition:'New',test_status:'',package_length_in:2,package_width_in:2,package_height_in:4,package_weight_lb:4,state:'available',listing_specs:{}};
function Test(){return <><UnitEditDrawer client={client} storeId="store" sku="99871" unit={unit} photos={[]} urls={{}} accessToken="test" appMode canDelete onClose={()=>{}} onSaved={()=>{window.saved=true}} onPhotosChanged={()=>{}} missingFields={gaps}/><nav className="app-tabs" data-testid="tabbar">Inventory · Receive · More</nav></>}
function Clerk(){return <><UnitEditDrawer client={client} storeId="store" sku="99871" unit={unit} photos={[]} urls={{}} accessToken="test" appMode onClose={()=>{}} onSaved={()=>{}} onPhotosChanged={()=>{}}/><nav className="app-tabs">Inventory · Receive · More</nav></>}
window.rpcCalls=[];window.fetch=async()=>({ok:true,status:200,json:async()=>({form:{sku:'99871',upc:'810205870267',enabled:false,category_id:'123',path:'Home > Candles',fields:[{name:'Type',required:true}],attributes:{},missing:['Type'],item:{title:unit.title,brand:'APOTHEKE',model:'2 Wick',condition:'New'}}})});document.documentElement.classList.add('app-mode');createRoot(document.getElementById('root')).render(<Test/>);window.renderClerk=()=>createRoot(document.getElementById('root')).render(<Clerk/>);
` }, bundle:true, write:false, platform:'browser', format:'iife', jsx:'automatic', define:{'import.meta.env':JSON.stringify({VITE_FLOOR_FUNCTIONS_URL:'',VITE_SUPABASE_URL:'',VITE_SUPABASE_ANON_KEY:''})} });
const browser = await chromium.launch({ headless:true, ...(process.env.MANIFEST_CHROMIUM_PATH?{executablePath:process.env.MANIFEST_CHROMIUM_PATH}:{}), args:['--no-sandbox'] });
try {
  for (const width of [390,820,1180]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><html><head><style>${css.join('\n')}body{margin:0}.app-tabs{position:fixed;bottom:0;left:0;right:0;height:56px;background:#222;color:#fff;z-index:30;display:grid;place-items:center}</style></head><body><div id="root"></div></body></html>`}));
    page.on('pageerror',e=>console.error('browser page error:',e.message));
    await page.goto('https://floor-inventory-edit.test');await page.addScriptTag({content:outputFiles[0].text});
    const dialog=page.getByRole('dialog',{name:'Edit unit 99871'});await dialog.waitFor({timeout:5000}).catch(async()=>{console.error('Editor DOM:',await page.locator('body').innerText());throw new Error('Edit drawer did not render');});
    assert.equal(await page.getByLabel('Cost',{exact:true}).count(),1,'admin can see cost');
    assert.equal(await page.locator('#unit-package-size').count(),1,'package shipping-size fields are visible');
    assert.equal(await page.locator('.unit-edit-dimensions input').count(),4,'package length, width, height and weight fields are shown');
    assert.equal(await page.getByRole('button',{name:/package size for shipping/i}).count(),0,'filled package dimensions do not show a false missing warning');
    await page.evaluate(()=>{const e=document.querySelector('.unit-edit-online .ebay-specifics');e.scrollIntoView=()=>{window.jumpedTo='specifics'}});
    await page.getByRole('button',{name:'Go to eBay item specifics',exact:true}).click();
    assert.equal(await page.locator('.unit-edit-online').evaluate(el=>el.open),true,'specifics jump opens Selling online');
    await page.locator('#unit-edit-price input').fill('19.00');await page.evaluate(()=>{window.nextGaps=[]});
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>window.saved);
    await page.waitForFunction(()=>!document.querySelector('.inventory-missing'));
    await page.locator('.inventory-detail').evaluate(el=>{el.scrollTop=el.scrollHeight});
    const metrics=await page.evaluate(()=>{const d=document.querySelector('.inventory-detail'),s=document.querySelector('.app-unit-edit-nav button:last-child'),del=document.querySelector('.unit-edit-delete'),tabs=document.querySelector('.app-tabs');const dr=d.getBoundingClientRect(),sr=s.getBoundingClientRect(),xr=del.getBoundingClientRect(),tr=tabs.getBoundingClientRect();return{scrollWidth:document.documentElement.scrollWidth,innerWidth:innerWidth,saveRight:sr.right,saveVisible:sr.width>0&&sr.top>=0&&sr.bottom<=innerHeight,deleteBottom:xr.bottom,tabTop:tr.top,drawerRight:dr.right,notesWidth:document.querySelector('.unit-edit-notes textarea').getBoundingClientRect().width}});
    assert.ok(metrics.scrollWidth<=metrics.innerWidth,`no horizontal overflow at ${width}px: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.saveVisible&&metrics.saveRight<=width,`Save stays visible at ${width}px`);
    assert.ok(metrics.deleteBottom<=metrics.tabTop,`Delete stays above tab bar at ${width}px: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.notesWidth>0,`Notes field is visible at ${width}px`);
    if(width===390)assert.equal(await page.locator('.unit-edit-grid').first().evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1,'phone fields use one column');
    if(width>=820)assert.ok(await page.locator('.unit-edit-grid').first().evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length)>=2,'tablet fields use two columns when they fit');
    await page.close();
  }
  const clerk=await browser.newPage({viewport:{width:390,height:844}});await clerk.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><html><head><style>${css.join('\n')}</style></head><body><div id="root"></div></body></html>`}));await clerk.goto('https://floor-inventory-edit.test');await clerk.addScriptTag({content:outputFiles[0].text});await clerk.evaluate(()=>window.renderClerk());await clerk.getByRole('dialog',{name:'Edit unit 99871'}).waitFor();assert.equal(await clerk.getByLabel('Cost',{exact:true}).count(),0,'clerk does not see cost');assert.equal(await clerk.getByRole('button',{name:'Delete item'}).count(),0,'clerk does not see admin actions');assert.equal(await clerk.locator('.channel-picker').count(),0,'clerk does not see listing channel toggles');
  console.log('PASS: item editor has direct missing-field jumps, rechecks readiness after save, fits 390/820/1180px with Save and Delete clear of the tab bar, and hides admin controls from clerks.');
} finally { await browser.close(); }
