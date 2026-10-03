// Production smoke test for an ambiguous scan. Credentials come from process env.
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url='https://zoukmsmbztcuyoslvikp.supabase.co',id=randomUUID();
const email=`floor-choice-test-${id}@example.invalid`,password=randomUUID()+randomUUID();
const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE,{auth:{persistSession:false}});
const client=createClient(url,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false}});
function check(result,label){if(result.error)throw new Error(`${label}: ${result.error.message}`);return result.data}
let userId;
try{
  const storeId=check(await admin.from('portal_admins').select('store_id').limit(1).single(),'store').store_id;
  userId=check(await admin.auth.admin.createUser({email,password,email_confirm:true}),'create user').user.id;
  check(await admin.from('portal_admins').insert({user_id:userId,store_id:storeId}),'membership');
  const session=check(await client.auth.signInWithPassword({email,password}),'login').session;
  check(await admin.from('video_scan_jobs').insert({id,store_id:storeId,created_by:userId,
    status:'ready',video_path:'test/no-video',still_paths:[],reserved_usd:0,result:{
      title:'Which Ninja blender?',brand:'Ninja',options:[
        {label:'Ninja BL610',title:'Ninja Professional Blender BL610',brand:'Ninja',model:'BL610',color:'Black'},
        {label:'Ninja BN701',title:'Ninja Professional Plus Blender BN701',brand:'Ninja',model:'BN701',color:'Black'}]}}),'create job');
  const response=await fetch('https://inventoryobi.netlify.app/.netlify/functions/video-scan-choice',{
    method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},
    body:JSON.stringify({id,index:0})});
  if(!response.ok)throw new Error(`choice function: ${response.status} ${await response.text()}`);
  let job;
  for(let n=0;n<60;n++){
    await new Promise(resolve=>setTimeout(resolve,500));
    job=check(await client.from('video_scan_jobs').select('result,search_queries').eq('id',id).single(),'poll');
    if(job.result?.retail_ready)break;
  }
  if(!job?.result?.retail_ready||job.result.model!=='BL610')throw new Error('Choice did not resolve to BL610');
  console.log(JSON.stringify({selected_model:job.result.model,retailer:job.result.retail_source_name,
    price_cents:job.result.msrp_cents,search_queries:job.search_queries}));
}finally{
  await admin.from('video_scan_jobs').delete().eq('id',id);
  if(userId)await admin.auth.admin.deleteUser(userId);
}
