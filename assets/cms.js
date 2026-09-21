(() => {
  'use strict';
  const grid = document.getElementById('cms-products');
  const promoGrid=document.getElementById('cms-promo-products');
  if (!grid && !promoGrid) return;
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const terms = JSON.parse((grid || promoGrid).dataset.terms || '[]');
  // La mayor\u00eda de estas im\u00e1genes viven localmente en el repo (sin depender
  // de ning\u00fan host externo), pero unas cuantas ya est\u00e1n re-hospedadas de
  // forma permanente en nuestro propio bucket de Supabase Storage \u2014 el
  // mismo dominio de confianza que usa el resto del sitio para im\u00e1genes de
  // productos migrados, as\u00ed que tambi\u00e9n se acepta aqu\u00ed.
  const TRUSTED_IMG_RE = /^(\/img\/cms-products\/[0-9]+\.jpg|https:\/\/iuoirslxjcyarvmrqyjd\.supabase\.co\/storage\/v1\/object\/public\/)/;
  function productCard(product) {
    const card = document.createElement('article');
    const link = document.createElement('a');link.className='cms-product-link';
    card.className = 'store-prod-card';
    if (!/^\d+$/.test(String(product.id)) || !product.linkRewrite) return null;
    link.href = '/' + product.id + '-' + encodeURIComponent(product.linkRewrite) + '.html';
    const image = document.createElement('img');
    if (!TRUSTED_IMG_RE.test(product.img)) return null;
    image.src = product.img; image.className='store-prod-img';
    image.alt=product.name; image.loading='lazy'; image.width=260; image.height=220;
    image.addEventListener('error',()=>image.remove(),{once:true});
    const copy=document.createElement('div');copy.className='store-prod-body';
    const title=document.createElement('h3');title.textContent=product.name;title.className='store-prod-title';
    const action=document.createElement('button');action.type='button';action.className='store-prod-btn';action.textContent='Agregar al carrito';action.addEventListener('click',()=>window.cmsAddToCart(product,action,status));
    const status=document.createElement('p');status.className='cms-cart-status';status.setAttribute('role','status');
    link.append(image,title);copy.append(action,status);card.append(link,copy);return card;
  }
  async function loadProducts() {
    try {
      const response=await fetch('/data/cms-products.json',{signal:AbortSignal.timeout(20000)});
      if(!response.ok) throw new Error('catalog');
      const data=await response.json();
      // Never fill a themed page with unrelated products when there are no matches.
      const productIds=JSON.parse(grid?.dataset.productIds || '[]');
      // Promo/paquete bundles belong only in the dedicated promotions section,
      // never mixed into the regular product catalog grid.
      const selected=productIds.length ? productIds.map(id=>({product:(data.products||[]).find(p=>p.id===id)})).filter(item=>item.product) : (data.products || []).filter(p=>!/promo|paquete/.test(norm(p.name))).map(product=>({product,score:terms.reduce((score,term)=>score+(norm(product.name).includes(term)?3:0),0)}))
        .filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,30);
      const promos=(data.products||[]).filter(p=>/promo|paquete/.test(norm(p.name)) && terms.some(t=>norm(p.name).includes(t)));
      if(promoGrid){
        const promoCards=promos.map(productCard).filter(Boolean);
        const promoFull=promoCards.length>=4 ? Math.floor(promoCards.length/4)*4 : promoCards.length;
        promoGrid.replaceChildren(...promoCards.slice(0,promoFull));
        promoGrid.hidden=!promoCards.length;
      }
      if(!grid)return;
      const cards=selected.map(item=>productCard(item.product)).filter(Boolean);
      if(!cards.length){grid.innerHTML='<p class="catalog-status">Consulta las opciones disponibles en el catálogo o escríbenos desde la página de contacto.</p>';return;}
      // Rows are always 4 products wide on desktop — never leave a short, orphaned
      // last row (e.g. 2 leftover items). If there are 4+ matches, drop the remainder
      // so every visible row is full; with fewer than 4 there's no full row to make.
      const full=cards.length>=4 ? Math.floor(cards.length/4)*4 : cards.length;
      grid.replaceChildren(...cards.slice(0,full));
    } catch {
      if(grid)grid.innerHTML='<p class="catalog-status">No pudimos cargar los productos en este momento. Puedes consultar el catálogo de la tienda.</p>';
    }
  }
  loadProducts();
})();
