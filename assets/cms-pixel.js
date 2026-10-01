(()=>{'use strict';
// Meta Pixel + embudo propio para las páginas CMS (estáticas). La tienda
// principal (index.html) ya hace esto mismo: aquí se repite lo que ocurre
// DENTRO de la página CMS — visita, agregar al carrito y contacto. Lo que pasa
// después de salir a la tienda (ver producto, buscar, checkout, compra) lo
// sigue registrando la tienda, así no se cuenta doble.
// El ID del píxel sale de ajustes_marketing (Backoffice → Meta Pixel).
const SB='https://iuoirslxjcyarvmrqyjd.supabase.co';
const KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';
const ls=(k,v)=>{try{return v===undefined?localStorage.getItem(k):localStorage.setItem(k,v);}catch{return null;}};
// Navegador del equipo (sesión de admin/personal guardada): no cuenta.
const isTeam=()=>!!(ls('mf_admin_pw')||ls('mf_staff_creds'));
let pending=[],ready=false;

function track(name,params,eventId){
  if(isTeam())return;
  if(window.fbq){eventId?fbq('track',name,params||{},{eventID:eventId}):fbq('track',name,params||{});}
  else if(!ready&&pending.length<50)pending.push([name,params||{},eventId]);
}
function initPixel(id){
  if(!id||window.fbq||isTeam())return;
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq('init',id);fbq('track','PageView');
  pending.splice(0).forEach(([n,p,e])=>e?fbq('track',n,p,{eventID:e}):fbq('track',n,p));
}

// ---- Embudo propio (mismo visitante/sesión que la tienda: mismas claves) ----
let queue=[],timer=null;
const rid=()=>(window.crypto&&crypto.randomUUID)?crypto.randomUUID().replace(/-/g,''):(Date.now().toString(36)+Math.random().toString(36).slice(2,14));
function origin(){
  try{
    const q=new URLSearchParams(location.search),utm=(q.get('utm_source')||'').toLowerCase(),ref=(document.referrer||'').toLowerCase(),host=ref?new URL(ref).hostname:'';
    if(host&&host.endsWith(location.hostname.replace(/^www\./,'')))return null;
    if(/instagram|^ig$/.test(utm)||host.includes('instagram'))return'instagram';
    if(/facebook|^fb$|meta/.test(utm)||q.get('fbclid')||host.includes('facebook')||host==='fb.me')return'facebook';
    if(/google/.test(utm)||q.get('gclid')||host.includes('google.'))return'google';
    if(/tiktok/.test(utm)||host.includes('tiktok'))return'tiktok';
    if(/whatsapp|wa/.test(utm)||host.includes('whatsapp'))return'whatsapp';
    if(/mail|newsletter/.test(utm)||host.includes('mail'))return'email';
    if(utm||host)return'otro';return'directo';
  }catch{return'directo';}
}
function session(){
  try{
    let vid=ls('mf_vid');if(!vid){vid=rid();ls('mf_vid',vid);}
    const now=Date.now(),last=Number(ls('mf_sid_ts')||0);let sid=ls('mf_sid'),o=ls('mf_sid_origen');const fresh=origin();
    if(!sid||now-last>30*60*1000||(fresh&&fresh!=='directo'&&fresh!==o)){sid=rid();o=fresh||'directo';ls('mf_sid',sid);ls('mf_sid_origen',o);}
    ls('mf_sid_ts',String(now));return{vid,sid,o};
  }catch{return null;}
}
const device=()=>{const ua=navigator.userAgent||'';return/iPad|Tablet/i.test(ua)?'tablet':/Mobi|Android|iPhone/i.test(ua)?'movil':'escritorio';};
function flush(){
  if(timer){clearTimeout(timer);timer=null;}if(!queue.length)return;
  const body=JSON.stringify({events:queue.splice(0,50)});
  try{if(navigator.sendBeacon&&navigator.sendBeacon('/api/evento',new Blob([body],{type:'text/plain'})))return;}catch{}
  fetch('/api/evento',{method:'POST',headers:{'Content-Type':'text/plain'},body,keepalive:true}).catch(()=>{});
}
function funnel(e,{productId,valor,datos}={}){
  if(navigator.webdriver||isTeam())return;const s=session();if(!s)return;
  queue.push({v:s.vid,s:s.sid,e,p:location.pathname,t:Date.now(),pid:productId,val:valor,o:s.o,dv:device(),d:datos});
  if(queue.length>=20){flush();return;}if(!timer)timer=setTimeout(flush,2000);
}
addEventListener('pagehide',flush);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flush();});

// ---- Acciones ----
funnel('visita');

// Agregar al carrito (lo avisa assets/cms-cart.js al guardar en el carrito).
addEventListener('cms-add-to-cart',ev=>{
  const d=ev.detail||{};if(!d.id)return;
  track('AddToCart',{content_ids:[String(d.id)],content_name:d.name,content_type:'product',value:d.price,currency:'MXN',contents:[{id:String(d.id),quantity:1}]});
  funnel('agregar_carrito',{productId:String(d.id),valor:d.price,datos:{nombre:String(d.name||''),cantidad:1}});
});

// Contacto: clic en WhatsApp / teléfono / correo (solo el canal, nunca el dato).
document.addEventListener('click',e=>{
  const a=e.target&&e.target.closest?e.target.closest('a[href*="wa.me/"],a[href^="tel:"],a[href^="mailto:"]'):null;if(!a)return;
  const h=a.getAttribute('href')||'',canal=h.indexOf('wa.me/')!==-1?'WhatsApp':h.indexOf('tel:')===0?'Teléfono':'Correo';
  track('Contact',{content_name:canal});funnel('contacto',{datos:{nombre:canal}});
},true);

// Config del píxel (se puede cambiar desde el Backoffice sin redesplegar).
fetch(SB+'/rest/v1/ajustes_marketing?select=meta_pixel_id,meta_pixel_activo&order=id.asc&limit=1',{headers:{apikey:KEY,Authorization:'Bearer '+KEY}})
 .then(r=>r.ok?r.json():[]).then(rows=>{const c=rows&&rows[0];if(c&&c.meta_pixel_activo&&c.meta_pixel_id)initPixel(c.meta_pixel_id);}).catch(()=>{}).finally(()=>{ready=true;pending=[];});
})();
