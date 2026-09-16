(() => {
  'use strict';
  const grid = document.getElementById('cms-products');
  if (!grid) return;
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const terms = JSON.parse(grid.dataset.terms || '[]');
  const currency = new Intl.NumberFormat('es-MX', {style:'currency',currency:'MXN'});
  function productCard(product) {
    const card = document.createElement('a');
    card.className = 'product-card';
    if (!/^\d+$/.test(String(product.id)) || !product.linkRewrite) return null;
    card.href = '/' + product.id + '-' + encodeURIComponent(product.linkRewrite) + '.html';
    const image = document.createElement('img');
    // PrestaShop rejects image hotlinks with a different site's Referer (HTTP 403).
    image.referrerPolicy = 'no-referrer';
    // Use the public product image path, not the API URL that contains the webservice key.
    const match = String(product.img || '').match(/\/images\/products\/\d+\/(\d+)/);
    if (match) image.src = 'https://mifiestashop.com/' + match[1] + '-home_default/' + encodeURIComponent(product.linkRewrite) + '.jpg';
    else { try { const url = new URL(product.img); if (/^https?:$/.test(url.protocol) && !url.searchParams.has('ws_key')) image.src=url.href; } catch {} }
    image.alt=product.name; image.loading='lazy'; image.width=260; image.height=220;
    image.addEventListener('error',()=>image.remove(),{once:true});
    const copy=document.createElement('div');copy.className='product-copy';
    const title=document.createElement('h3');title.textContent=product.name;
    const price=document.createElement('span');price.className='price';price.textContent=currency.format(Number(product.price || 0))+' MXN';
    const action=document.createElement('span');action.className='view-product';action.textContent='Ver producto';
    copy.append(title,price,action);card.append(image,copy);return card;
  }
  async function loadProducts() {
    try {
      const response=await fetch('/api/productos?limit=1000',{signal:AbortSignal.timeout(20000)});
      if(!response.ok) throw new Error('catalog');
      const data=await response.json();
      // Never fill a themed page with unrelated products when there are no matches.
      const selected=(data.products || []).map(product=>({product,score:terms.reduce((score,term)=>score+(norm(product.name).includes(term)?3:0),0)}))
        .filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,8);
      const cards=selected.map(item=>productCard(item.product)).filter(Boolean);
      if(!cards.length){grid.innerHTML='<p class="catalog-status">Consulta las opciones disponibles en el catálogo o escríbenos desde la página de contacto.</p>';return;}
      grid.replaceChildren(...cards);
    } catch {
      grid.innerHTML='<p class="catalog-status">No pudimos cargar los productos en este momento. Puedes consultar el catálogo de la tienda.</p>';
    }
  }
  loadProducts();
})();
