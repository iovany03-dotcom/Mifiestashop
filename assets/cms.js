(() => {
  'use strict';
  const grid = document.getElementById('cms-products');
  const promoGrid=document.getElementById('cms-promo-products');
  if (!grid && !promoGrid) return;
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const terms = JSON.parse((grid || promoGrid).dataset.terms || '[]');
  function productCard(product) {
    const card = document.createElement('article');
    const link = document.createElement('a');link.className='cms-product-link';
    card.className = 'store-prod-card';
    if (!/^\d+$/.test(String(product.id)) || !product.linkRewrite) return null;
    link.href = '/' + product.id + '-' + encodeURIComponent(product.linkRewrite) + '.html';
    const image = document.createElement('img');
    if (!/^\/img\/cms-products\/[0-9]+\.jpg$/.test(product.img)) return null;
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
      const selected=productIds.length ? productIds.map(id=>({product:(data.products||[]).find(p=>p.id===id)})).filter(item=>item.product) : (data.products || []).map(product=>({product,score:terms.reduce((score,term)=>score+(norm(product.name).includes(term)?3:0),0)}))
        .filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,30);
      const promos=(data.products||[]).filter(p=>/promo|paquete/.test(norm(p.name)) && terms.some(t=>norm(p.name).includes(t)));
      if(promoGrid){promoGrid.replaceChildren(...promos.map(productCard).filter(Boolean));promoGrid.hidden=!promos.length;}
      if(!grid)return;
      const cards=selected.map(item=>productCard(item.product)).filter(Boolean);
      if(!cards.length){grid.innerHTML='<p class="catalog-status">Consulta las opciones disponibles en el catálogo o escríbenos desde la página de contacto.</p>';return;}
      grid.replaceChildren(...cards);
    } catch {
      if(grid)grid.innerHTML='<p class="catalog-status">No pudimos cargar los productos en este momento. Puedes consultar el catálogo de la tienda.</p>';
    }
  }
  loadProducts();
})();
