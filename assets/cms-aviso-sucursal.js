(()=>{'use strict';
// Pop-up de aviso para las páginas CMS de una sucursal (body[data-city]): se muestra una vez por visita
// mientras dure el aviso. Para otro cierre, cambia las constantes de abajo (y la barra superior en
// scripts/cms-header.html, data-desde / data-hasta) y vuelve a generar las páginas (npm run build:cms).
const CIUDAD='queretaro';
const DESDE='2026-10-08', HASTA='2026-10-14';   // se muestra de DESDE a HASTA (inclusive), hora de México
const TITULO='Sucursal Querétaro cerrada';
const TEXTO='Nuestra sucursal de Querétaro estará <b>cerrada del 12 al 14 de octubre</b>. ¡Anticipa tu compra! Puedes pedir en línea o pasar por tus productos antes del cierre.';
const CLAVE='mf_aviso_'+CIUDAD+'_'+HASTA;
function listo(){
  try{
    if((document.body.dataset.city||'')!==CIUDAD)return;
    const hoy=new Date().toLocaleDateString('sv-SE',{timeZone:'America/Mexico_City'});
    if(hoy<DESDE||hoy>HASTA)return;
    try{if(sessionStorage.getItem(CLAVE))return;}catch{}
    const css=document.createElement('style');
    css.textContent='.cms-aviso{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(46,16,101,.55)}'
    +'.cms-aviso[hidden]{display:none}'
    +'.cms-aviso-card{background:#fff;color:#2e1065;border-radius:18px;max-width:440px;width:100%;padding:26px 24px 22px;box-shadow:0 18px 50px rgba(0,0,0,.35);text-align:center;font-family:Poppins,system-ui,sans-serif;position:relative}'
    +'.cms-aviso-card h2{margin:6px 0 10px;font-size:1.35rem;line-height:1.25}.cms-aviso-card p{margin:0 0 18px;font-size:1rem;line-height:1.5}'
    +'.cms-aviso-x{position:absolute;top:8px;right:12px;border:0;background:none;font-size:26px;line-height:1;cursor:pointer;color:#7c6a99}'
    +'.cms-aviso-btns{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}'
    +'.cms-aviso-btns a,.cms-aviso-btns button{flex:1 1 150px;padding:12px 14px;border-radius:999px;font:700 .95rem Poppins,system-ui,sans-serif;cursor:pointer;text-decoration:none;text-align:center}'
    +'.cms-aviso-ok{background:#d3007b;color:#fff;border:0}.cms-aviso-sec{background:#fff;color:#2e1065;border:2px solid #e5dce6}';
    document.head.appendChild(css);
    const m=document.createElement('div');
    m.className='cms-aviso';m.setAttribute('role','dialog');m.setAttribute('aria-modal','true');m.setAttribute('aria-labelledby','cmsAvisoTitulo');
    m.innerHTML='<div class="cms-aviso-card"><button type="button" class="cms-aviso-x" aria-label="Cerrar aviso">×</button><div style="font-size:38px" aria-hidden="true">📍</div>'
      +'<h2 id="cmsAvisoTitulo">'+TITULO+'</h2><p>'+TEXTO+'</p>'
      +'<div class="cms-aviso-btns"><a class="cms-aviso-ok" href="/266-productos">Comprar en línea</a><button type="button" class="cms-aviso-sec">Entendido</button></div></div>';
    const cerrar=()=>{m.remove();document.removeEventListener('keydown',tecla);try{sessionStorage.setItem(CLAVE,'1');}catch{}};
    const tecla=e=>{if(e.key==='Escape')cerrar();};
    m.querySelector('.cms-aviso-x').addEventListener('click',cerrar);
    m.querySelector('.cms-aviso-sec').addEventListener('click',cerrar);
    m.querySelector('.cms-aviso-ok').addEventListener('click',()=>{try{sessionStorage.setItem(CLAVE,'1');}catch{}});
    m.addEventListener('click',e=>{if(e.target===m)cerrar();});
    document.addEventListener('keydown',tecla);
    document.body.appendChild(m);
    m.querySelector('.cms-aviso-sec').focus();
  }catch{}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',listo);else listo();
})();
