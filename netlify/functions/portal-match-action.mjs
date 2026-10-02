import { createClient } from "@supabase/supabase-js";
import { serviceClient, requireEnv, json, corsHeaders } from "../lib/server.mjs";
import { publishAsset } from "../lib/photo-match-worker.mjs";

export async function handler(event) {
  if(event.httpMethod==="OPTIONS")return {statusCode:204,headers:corsHeaders(),body:""};
  if(event.httpMethod!=="POST")return json(405,{error:"POST required"});
  try{
    const token=(event.headers.authorization||event.headers.Authorization||"").replace(/^Bearer\s+/i,"");
    if(!token)return json(401,{error:"Sign in required"});
    const sb=serviceClient();
    const {data:auth,error:authError}=await sb.auth.getUser(token);
    if(authError||!auth.user)return json(401,{error:"Sign in required"});
    const {data:member,error:memberError}=await sb.from("portal_admins").select("store_id").eq("user_id",auth.user.id).maybeSingle();
    if(memberError||!member)return json(403,{error:"Admin access required"});
    const {id,action}=JSON.parse(event.body||"{}");
    if(!/^[0-9a-f-]{36}$/i.test(String(id))||!["approve","reject"].includes(action))return json(400,{error:"Invalid review action"});
    const user=createClient(requireEnv("SUPABASE_URL"),requireEnv("SUPABASE_ANON_KEY"),{
      global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}
    });
    if(action==="reject"){
      const result=await user.rpc("portal_reject_match",{p_suggestion:id});
      if(result.error)throw result.error;
      return json(200,{ok:true,status:"rejected"});
    }
    const {data:suggestion,error:suggestionError}=await sb.from("photo_enrichment_suggestions")
      .select("store_id,status,asset_id").eq("id",id).single();
    if(suggestionError||suggestion.store_id!==member.store_id||suggestion.status!=="review")return json(404,{error:"Review match not found"});
    const {data:asset,error:assetError}=await sb.from("photo_enrichment_assets").select("*").eq("id",suggestion.asset_id).eq("store_id",member.store_id).single();
    if(assetError||!asset)throw assetError||new Error("Candidate missing");
    await publishAsset(sb,asset);
    const result=await user.rpc("portal_approve_match",{p_suggestion:id});
    if(result.error)throw result.error;
    return json(200,{ok:true,status:"approved"});
  }catch(error){return json(500,{error:error instanceof Error?error.message:String(error)});}
}
