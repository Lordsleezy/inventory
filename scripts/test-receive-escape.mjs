/** Android-size clerk Receive, with real React/DOM and mocked services. No live data. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.MANIFEST_PLAYWRIGHT_PATH ? pathToFileURL(process.env.MANIFEST_PLAYWRIGHT_PATH).href : 'playwright');
const store = '10000000-0000-0000-0000-000000000001', actor = '20000000-0000-0000-0000-000000000002';
const title = 'Jewelry Organizer Box with Necklace Stand, White and Gold';
const { outputFiles } = await build({ outfile: '/tmp/floor-receive-test.js', stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client';
  import {ReceivePanel} from './apps/admin/src/ReceivePanel';
  const s=window.__scenario; window.__calls=[];
  const identity=s.stub ? {title:'ACHIM Rustic',brand:'ACHIM',item_type:'Curtain',model:'Rustic',title_complete:false}
    : s.fridge ? {title:'Whirlpool Stainless Steel Refrigerator, 18 cubic feet',brand:'Whirlpool',item_type:'Refrigerator',model:'Refrigerator'}
    : {title:'${title}',brand:'',no_brand:true,item_type:'Jewelry Organizer Box',model:'Jewelry Organizer Box',category:'Home',color:'White and Gold',title_complete:true};
  const client={
    auth:{getSession:async()=>({data:{session:{user:{id:'${actor}'}}}})},
    storage:{from:()=>({upload:async(path)=>{window.__calls.push({upload:path});return {data:{path},error:null}}})},
    rpc:async(name,args)=>{
      window.__calls.push({name,args});
      if(name==='staff_receive_options'||name==='portal_receive_options')return {data:{next_sku:'99878',categories:['Home'],conditions:['New','Open box'],test_statuses:['untested']}};
      if(name==='portal_manifest_receive_reference')return {data:{retail_cents:4999,manifest_name:'Oct 28 B-Stock load',manifest_on:'2026-10-28',warnings:[{manifest_name:'Load',total_qty:14,defective_qty:2,conditions:['SALVAGE']}]}};
      if(name==='receive_commit')return s.saveError ? {error:{message:'Temporary save error'}} : {data:{skus:['99878'],server_ms:1}};
      if(name==='receive_work_status')return {data:[]};
      return {data:null};
    },
    from:table=>{window.__calls.push({table});const q=new Proxy({},{get:(_,k)=>k==='then'?resolve=>resolve({data:[]}):()=>q});return q},
  };
  window.fetch=async(url,options)=>{
    const body=JSON.parse(options?.body||'{}');window.__calls.push({url,body});
    if(String(url).includes('upc-lookup'))return Response.json(s.found||s.fridge ? {amazon:{found:true},merged:s.fridge
      ? {title:identity.title,brand:'Whirlpool',model:'Refrigerator',category:'Home'}
      : {title:'ACHIM Buffalo Check Window Curtain Panel, White',brand:'ACHIM',model:'Window Curtain Panel',category:'Home'}}
      : {true_miss:true,store_label:!!s.sticker,amazon:{found:false},upcitemdb:{found:false},merged:{not_found:true}});
    if(body.action==='identify_only'){
      if(s.photoSlow)return await new Promise(resolve=>window.__releasePhoto=()=>resolve(Response.json({identity,fill:identity})));
      if(s.photoError)return Response.json({message:'AI temporarily unavailable'},{status:503});
      return Response.json({identity,fill:identity});
    }
    if(body.action==='confirm_identity')return Response.json(s.cacheError ? {message:'Catalog unavailable'} : {ok:true,product:{images:[]}},{status:s.cacheError?503:200});
    return Response.json({ok:true,price:{count:0},dimensions:{values:{},sources:{},warnings:[]}});
  };
  // Simulate an Android IME which cannot be opened with the physical scanner paired.
  Object.defineProperty(navigator,'virtualKeyboard',{configurable:true,value:{show(){throw new Error('Hardware keyboard suppresses Android IME')}}});
  createRoot(document.getElementById('root')).render(<ReceivePanel client={client} storeId="${store}" accessToken="test" staffMode storePhoneMode appChrome
    initialUpc={s.empty?'':s.sticker?'490680352443':'096801681609'} onSaved={()=>window.__saved=true}/>);
` }, bundle: true, write: false, platform: 'browser', format: 'iife', external: ['@techstark/opencv-js'], jsx: 'automatic', define: { 'import.meta.env': '{}' } });
const browser = await chromium.launch({ headless: true, ...(process.env.MANIFEST_CHROMIUM_PATH ? {executablePath:process.env.MANIFEST_CHROMIUM_PATH}:{}), args:['--no-sandbox'] });
async function mount(page, scenario) {
  await page.evaluate(s => { window.__scenario=s; },scenario);
  await page.addScriptTag({content:outputFiles[0].text});
  await page.getByText('Receive · 99878',{exact:true}).waitFor();
}
async function open(scenario={}) {
  const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 13; moto g play) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36'});
  const page=await context.newPage();
  page.on('pageerror',error=>console.error('Receive page error:',error.message));
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('https://floor-receive.test/');
  if(scenario.recovery)await page.evaluate(({key,value})=>localStorage.setItem(key,JSON.stringify(value)),scenario.recovery);
  await mount(page,scenario); return page;
}
async function photo(page, fromForm=false) {
  const base64=await page.evaluate(()=>{
    const c=document.createElement('canvas');c.width=c.height=600;const g=c.getContext('2d');
    for(let i=0;i<600;i++){g.fillStyle='rgb('+i%255+',150,'+(i*3)%255+')';g.fillRect(0,i,600,1)}
    g.fillStyle='black';g.font='30px sans-serif';g.fillText('Jewelry organizer box',20,100);return c.toDataURL('image/jpeg',.9).split(',')[1];
  });
  const locator=fromForm?page.locator('.receive-photo-first input[type=file]').first():page.getByLabel('Choose product photo',{exact:true});
  await locator.setInputFiles({name:'organizer.jpg',mimeType:'image/jpeg',buffer:Buffer.from(base64,'base64')});
}
const ai = page => page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Confirm product from photo',exact:true})});
const cancel = page => page.getByRole('button',{name:'Cancel item — scan next',exact:true}).last();
async function scanReady(page) {
  const input=page.locator('input[data-receive-scan]:not(:disabled)');await input.waitFor();
  await page.waitForFunction(()=>document.activeElement?.hasAttribute('data-receive-scan'));
  assert.equal(await page.getByRole('dialog').count(),0); return input;
}
try {
  // No typing: scan miss -> photograph -> No brand -> confirm -> receive.
  const p=await open();await p.getByRole('button',{name:'Yes — take photo'}).waitFor();await photo(p);await ai(p).waitFor();
  await ai(p).getByRole('button',{name:'No brand',exact:true}).click();
  await ai(p).getByRole('button',{name:'Use photo product',exact:true}).click();
  await p.getByRole('button',{name:'Save & next',exact:true}).waitFor();
  assert.equal(await p.getByLabel('Item title',{exact:true}).inputValue(),title);
  assert.equal(await p.locator('input[placeholder="0.00"]').inputValue(),'');
  assert.equal(await p.getByRole('dialog',{name:'Floor typing pad'}).count(),0,'common path requires no keyboard');
  await p.getByRole('button',{name:'Save & next',exact:true}).click();
  await p.waitForFunction(()=>window.__saved===true);
  let request=await p.evaluate(()=>window.__calls.find(c=>c.name==='receive_commit').args);
  assert.equal(request.p_fields.p_brand,'Unbranded'); assert.equal(request.p_fields.p_title,title);
  assert.equal(request.p_fields.p_cost_cents,null);assert.equal(request.p_fields.p_ask_cents,null);
  assert.deepEqual(request.p_extras.channels,[]);assert.equal(request.p_extras.dns,false);
  assert.equal(request.p_extras.photo_identity_confirmed,true);
  console.log('PASS: unbranded miss/photo/confirm/save with no typing, no auto-price or clerk cost/channel controls');

  for(const scenario of [{},{sticker:true},{photoError:true},{stub:true},{found:true}]) {
    const page=await open(scenario);
    if(!scenario.found)await page.getByRole('button',{name:'Yes — take photo'}).waitFor();
    await photo(page,!!scenario.found);
    if(!scenario.photoError)await ai(page).waitFor();else await page.getByText('AI temporarily unavailable',{exact:true}).waitFor();
    if(scenario.stub){await ai(page).getByRole('button',{name:'Use photo product'}).click();await page.getByText('Use a descriptive title: what it is plus color, size or material. No brand is OK.',{exact:true}).waitFor()}
    await page.getByRole('button',{name:'Enter details myself',exact:true}).click();
    assert.equal(await page.getByRole('dialog').count(),0);
    await page.getByRole('button',{name:'Cancel item — scan next',exact:true}).first().click(); await scanReady(page);
  }
  const miss=await open();await miss.getByRole('button',{name:'Yes — take photo'}).waitFor();await cancel(miss).click();await scanReady(miss);
  const candidate=await open();await candidate.getByRole('button',{name:'Yes — take photo'}).waitFor();await photo(candidate);await ai(candidate).waitFor();await cancel(candidate).click();await scanReady(candidate);
  const slow=await open({photoSlow:true});await slow.getByRole('button',{name:'Yes — take photo'}).waitFor();await photo(slow);await slow.waitForFunction(()=>!!window.__releasePhoto);await cancel(slow).click();await scanReady(slow);await slow.evaluate(()=>window.__releasePhoto());
  await slow.waitForTimeout(100);assert.equal(await slow.getByRole('dialog').count(),0,'late AI cannot resurrect canceled popup');
  console.log('PASS: all AI/error/stub/sticker/mismatch exits and late-response cancellation');

  const keyboard=await open({found:true});await keyboard.getByLabel('Item title',{exact:true}).waitFor();
  await keyboard.getByLabel('Item title',{exact:true}).click();const pad=keyboard.getByRole('dialog',{name:'Floor typing pad',exact:true});await pad.waitFor();
  await pad.getByRole('button',{name:'Clear',exact:true}).click();
  for(const ch of 'jewelry organizer white and gold')await pad.getByRole('button',{name:ch===' '?'Space':ch,exact:true}).click();
  assert.equal(await keyboard.getByLabel('Item title',{exact:true}).inputValue(),'jewelry organizer white and gold');
  await pad.getByRole('button',{name:'Done',exact:true}).click();
  await keyboard.locator('input[placeholder="0.00"]').click();const digits=keyboard.getByRole('dialog',{name:'Floor typing pad',exact:true});await digits.waitFor();
  for(const ch of '19.99')await digits.getByRole('button',{name:ch,exact:true}).click();
  assert.equal(await keyboard.locator('input[placeholder="0.00"]').inputValue(),'19.99');
  await digits.getByRole('button',{name:'Done',exact:true}).click();await keyboard.getByRole('button',{name:'Cancel item — scan next',exact:true}).first().click();
  const scanner=await scanReady(keyboard);await keyboard.keyboard.type('096801681609\n',{delay:5});await keyboard.getByLabel('Item title',{exact:true}).waitFor();assert.equal(await scanner.isDisabled(),true);
  console.log('PASS: built-in title/price typing with unavailable IME; hardware wedge scan works after typing/cancel');

  const record={p_request:'99878-recovery',p_fields:{p_brand:'',p_title:title},p_extras:{photo_identity_confirmed:true,photo_identity_type:'Jewelry Organizer Box'},p_photos:[store+'/receive/'+actor+'/99878-recovery/unit.jpg']};
  const key='floor:pending-receive:'+store;
  const recovery=await open({empty:true,recovery:{key,value:record}});await recovery.getByLabel('Recovery item title',{exact:true}).waitFor();
  assert.equal(await recovery.getByRole('dialog').count(),0,'restored drafts are nonmodal');
  await recovery.reload();await mount(recovery,{empty:true});await recovery.getByLabel('Recovery item title',{exact:true}).waitFor();
  await recovery.locator('.receive-recovery-card').getByRole('button',{name:'No brand',exact:true}).click();
  await recovery.getByRole('button',{name:'Recover interrupted save',exact:true}).click();await recovery.getByText('Saved SKU 99878. Ready for the next scan.',{exact:false}).waitFor();
  request=await recovery.evaluate(()=>window.__calls.find(c=>c.name==='receive_commit').args);assert.equal(request.p_fields.p_brand,'Unbranded');assert.equal(request.p_request,'99878-recovery');
  const drop=await open({empty:true,recovery:{key,value:record}});await drop.getByLabel('Recovery item title',{exact:true}).waitFor();await drop.getByRole('button',{name:'Cancel recovery — scan next',exact:true}).click();await scanReady(drop);
  await drop.reload();await mount(drop,{empty:true});await drop.getByRole('button',{name:'Discard',exact:true}).click();assert.equal(await drop.evaluate(k=>localStorage.getItem(k),key),null);await scanReady(drop);
  console.log('PASS: restart with legacy 99878 recovery -> No brand/recover, or Cancel/Discard without clearing Chrome');

  const cache=await open({cacheError:true});await cache.getByRole('button',{name:'Yes — take photo'}).waitFor();await photo(cache);await ai(cache).waitFor();await ai(cache).getByRole('button',{name:'Use photo product'}).click();
  await cache.getByText('Photo details kept. UPC catalog update is unavailable; you can still save this unit.',{exact:true}).waitFor();await cache.getByRole('button',{name:'Save & next',exact:true}).click();await cache.waitForFunction(()=>window.__saved===true);
  const failure=await open({saveError:true});await failure.getByRole('button',{name:'Yes — take photo'}).waitFor();await photo(failure);await ai(failure).waitFor();await ai(failure).getByRole('button',{name:'Use photo product'}).click();await failure.getByRole('button',{name:'Save & next',exact:true}).click();await failure.getByText(/Temporary save error/).waitFor();await failure.getByRole('button',{name:'Cancel item — scan next',exact:true}).first().click();await scanReady(failure);
  const fridge=await open({fridge:true});await fridge.getByLabel('Item title',{exact:true}).waitFor();await photo(fridge,true);await ai(fridge).waitFor();await ai(fridge).getByRole('button',{name:'Use photo product'}).click();await fridge.getByRole('button',{name:'Save & next',exact:true}).click();await fridge.waitForFunction(()=>window.__saved===true);
  request=await fridge.evaluate(()=>window.__calls.find(c=>c.name==='receive_commit').args);assert.equal(request.p_extras.dns,false);assert.deepEqual(request.p_extras.channels,[]);assert.equal(request.p_fields.p_cost_cents,null);assert.equal(request.p_extras.enrichment.specs.do_not_ship,undefined);
  assert.equal(await fridge.getByRole('checkbox',{name:/eBay|Amazon|TikTok/}).count(),0);
  console.log('PASS: cache/save errors remain escapable; fridge clerk request preserves DNS and cost/channel guards');
} finally {await browser.close()}
