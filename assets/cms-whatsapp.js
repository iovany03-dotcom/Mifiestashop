(()=>{'use strict';
// Botón flotante de WhatsApp en todas las páginas CMS (mismo número y mascota que la tienda).
// Los clics los cuenta cms-pixel.js como "Contact" (cualquier enlace a wa.me/).
if(document.querySelector('.cms-whatsapp-float,.store-whatsapp-float'))return;
const NUMERO='525612622146';
function montar(){
  if(document.querySelector('.cms-whatsapp-float'))return;
  const titulo=(document.querySelector('h1')||{}).textContent||document.title||'';
  const msg='Hola, vi la página "'+titulo.replace(/\s+/g,' ').trim().slice(0,90)+'" de Mi Fiestashop y quiero más información.';
  const css=document.createElement('style');
  css.textContent='.cms-whatsapp-float{position:fixed;right:16px;bottom:16px;z-index:900;display:flex;align-items:flex-end;gap:10px;text-decoration:none}'
  +'.cms-whatsapp-float img{width:96px;height:96px;object-fit:contain;filter:drop-shadow(0 8px 14px rgba(0,0,0,.28));animation:cmsWaBounce 2.6s ease-in-out infinite}'
  +'.cms-whatsapp-bubble{background:#fff;color:#2e1065;font:600 .85rem/1.4 Poppins,system-ui,sans-serif;padding:12px 15px;border-radius:16px;box-shadow:0 6px 18px rgba(46,16,101,.18);max-width:190px;position:relative;margin-bottom:30px;transition:opacity .4s ease,transform .4s ease}'
  +'.cms-whatsapp-bubble.is-hidden{opacity:0;transform:translateY(8px);pointer-events:none}'
  +'.cms-whatsapp-bubble::after{content:"";position:absolute;right:22px;bottom:-8px;border-left:8px solid transparent;border-right:8px solid transparent;border-top:8px solid #fff}'
  +'@keyframes cmsWaBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}'
  +'@media(max-width:600px){.cms-whatsapp-float img{width:76px;height:76px}.cms-whatsapp-bubble{display:none}}'
  +'@media print{.cms-whatsapp-float{display:none}}';
  document.head.appendChild(css);
  const a=document.createElement('a');
  a.className='cms-whatsapp-float';a.href='https://wa.me/'+NUMERO+'?text='+encodeURIComponent(msg);
  a.target='_blank';a.rel='noopener';a.setAttribute('aria-label','Contáctanos por WhatsApp');a.title='Contáctanos por WhatsApp';
  a.innerHTML='<div class="cms-whatsapp-bubble">¡Hola! Soy Mikel.<br>Estoy aquí para ayudarte.</div><img src="/img/whatsapp-support.webp" alt="Mikel, soporte por WhatsApp" width="96" height="96">';
  document.body.appendChild(a);
  const bubble=a.querySelector('.cms-whatsapp-bubble');let t=setTimeout(()=>bubble.classList.add('is-hidden'),6000);
  a.addEventListener('mouseenter',()=>{clearTimeout(t);bubble.classList.remove('is-hidden');});
  a.addEventListener('mouseleave',()=>{t=setTimeout(()=>bubble.classList.add('is-hidden'),2500);});
}
if(document.body)montar();else document.addEventListener('DOMContentLoaded',montar);
})();
