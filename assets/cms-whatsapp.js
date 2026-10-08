(()=>{'use strict';
// Botón flotante de WhatsApp en todas las páginas CMS (mismo número y mascota que la tienda).
// Los clics los cuenta cms-pixel.js como "Contact" (cualquier enlace a wa.me/).
const yaHayFlotante=!!document.querySelector('.store-whatsapp-float');
const NUMERO='525612622146';
function montar(){
  if(yaHayFlotante||document.querySelector('.cms-whatsapp-float'))return;
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
// Botón verde "Escríbenos por WhatsApp" flotando a la derecha (encima de la mascota), siempre
// visible al bajar por la página: el flotante con la mascota no siempre se reconoce como WhatsApp.
function botonesEnLinea(){
  if(document.querySelector('.cms-wa-inline'))return;
  const titulo=(document.querySelector('h1')||{}).textContent||document.title||'';
  const href='https://wa.me/'+NUMERO+'?text='+encodeURIComponent('Hola, vi la página "'+titulo.replace(/\s+/g,' ').trim().slice(0,90)+'" de Mi Fiestashop y quiero más información.');
  const icono='<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2zm5.8 14.15c-.24.68-1.4 1.3-1.93 1.38-.49.07-1.12.1-1.8-.11a16.4 16.4 0 0 1-1.63-.6c-2.87-1.24-4.74-4.13-4.88-4.32-.14-.19-1.17-1.55-1.17-2.96s.74-2.1 1-2.39c.26-.28.57-.35.76-.35h.55c.18 0 .42-.07.65.5.24.58.82 2 .89 2.15.07.14.12.31.02.5-.1.19-.14.31-.28.48l-.43.5c-.14.14-.29.3-.12.59.17.28.74 1.22 1.59 1.98 1.09.97 2.01 1.27 2.3 1.41.28.14.45.12.61-.07.17-.19.71-.83.9-1.11.19-.28.38-.24.64-.14.26.09 1.66.78 1.94.92.28.14.47.21.54.33.07.12.07.68-.17 1.36z"/></svg>';
  const conMascota=!!document.querySelector('.cms-whatsapp-float,.store-whatsapp-float');
  const css=document.createElement('style');
  css.textContent='.cms-wa-inline{position:fixed;right:16px;bottom:'+(conMascota?'124px':'20px')+';z-index:901;display:inline-flex;align-items:center;gap:8px;background:#25d366;color:#fff;font:700 14px/1 Poppins,system-ui,sans-serif;padding:13px 18px;border-radius:999px;text-decoration:none;box-shadow:0 8px 20px rgba(0,0,0,.22);transition:transform .15s,background .15s}'
  +'.cms-wa-inline:hover{background:#1da851;transform:translateY(-2px)}'
  +'@media(max-width:600px){.cms-wa-inline{bottom:'+(conMascota?'100px':'16px')+';padding:12px;border-radius:50%}.cms-wa-inline span{display:none}}'
  +'@media print{.cms-wa-inline{display:none}}';
  document.head.appendChild(css);
  const a=document.createElement('a');a.className='cms-wa-inline';a.href=href;a.target='_blank';a.rel='noopener';
  a.setAttribute('aria-label','Escríbenos por WhatsApp');a.innerHTML=icono+'<span>Escríbenos por WhatsApp</span>';
  document.body.appendChild(a);
}
function iniciar(){montar();botonesEnLinea();}
if(document.body)iniciar();else document.addEventListener('DOMContentLoaded',iniciar);
})();
