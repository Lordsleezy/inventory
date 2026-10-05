export default {
  async email(message, env) {
    await message.forward('paul@sentinelprime.org');
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    let binary=''; for(let i=0;i<raw.length;i+=0x8000)binary+=String.fromCharCode(...raw.subarray(i,i+0x8000));
    const res=await fetch(env.FLOOR_MARKETPLACE_EMAIL_URL,{method:'POST',headers:{'content-type':'application/json','x-marketplace-secret':env.FLOOR_MARKETPLACE_EMAIL_SECRET,'x-raw-email-base64':btoa(binary)}});
    if(!res.ok)throw new Error(`Floor intake returned ${res.status}`);
  }
};
