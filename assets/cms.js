(() => {
  'use strict';
  const grid = document.getElementById('cms-products');
  if (!grid) return;
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const terms = JSON.parse(grid.dataset.terms || '[]');
  function productCard(product) {
    const card = document.createElement('a');
    card.className = 'product-card';
    if (!/^\d+$/.test(String(product.id)) || !product.linkRewrite) return null;
    card.href = '/' + product.id + '-' + encodeURIComponent(product.linkRewrite) + '.html';
    const image = document.createElement('img');
    if (!/^\/img\/cms-products\/[0-9]+\.jpg$/.test(product.img)) return null;
    image.src = product.img;
    image.alt=product.name; image.loading='lazy'; image.width=260; image.height=220;
    image.addEventListener('error',()=>image.remove(),{once:true});
    const copy=document.createElement('div');copy.className='product-copy';
    const title=document.createElement('h3');title.textContent=product.name;
    const action=document.createElement('span');action.className='view-product';action.textContent='Ver producto';
    copy.append(title,action);card.append(image,copy);return card;
  }
  async function loadProducts() {
    try {
      const response=await fetch('/data/cms-products.json',{signal:AbortSignal.timeout(20000)});
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
