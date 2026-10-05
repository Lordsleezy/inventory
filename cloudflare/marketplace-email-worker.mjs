export default {
  async email(message, env) {
    try { await message.forward(env.OWNER_EMAIL || 'pgg124@gmail.com'); } catch (error) { console.error('Owner copy forward failed', error); }
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    let binary=''; for(let i=0;i<raw.length;i+=0x8000)binary+=String.fromCharCode(...raw.subarray(i,i+0x8000));
    const res=await fetch(env.FLOOR_MARKETPLACE_EMAIL_URL,{method:'POST',headers:{'content-type':'application/json','x-marketplace-secret':env.FLOOR_MARKETPLACE_EMAIL_SECRET},body:JSON.stringify({raw:btoa(binary)})});
    if(!res.ok)throw new Error(`Floor intake returned ${res.status}`);
  }
};
