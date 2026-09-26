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
  const money = n => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const CART_LABEL = '🛒 Agregar al Carrito';
  // Precio y SKU reales, en vivo, solo de los productos que se van a mostrar
  // (?ids=...): la misma información y cálculo que la tienda principal.
  // Si la consulta falla, las tarjetas se muestran sin precio en vez de fallar.
  async function fetchLive(ids) {
    try {
      const response = await fetch('/api/productos?ids=' + ids.join(','), { signal: AbortSignal.timeout(20000) });
      if (!response.ok) return new Map();
      const data = await response.json();
      return new Map((data.products || []).map(p => [Number(p.id), p]));
    } catch { return new Map(); }
  }
  function productCard(product, live) {
    if (!/^\d+$/.test(String(product.id)) || !product.linkRewrite) return null;
    if (!TRUSTED_IMG_RE.test(product.img)) return null;
    const href = '/' + product.id + '-' + encodeURIComponent(product.linkRewrite) + '.html';
    const card = document.createElement('article');
    card.className = 'store-prod-card';
    const imageLink = document.createElement('a'); imageLink.className = 'cms-product-link'; imageLink.href = href;
    imageLink.setAttribute('aria-label', product.name);
    const image = document.createElement('img');
    image.src = product.img; image.className = 'store-prod-img';
    image.alt = product.name; image.loading = 'lazy'; image.width = 260; image.height = 220;
    image.addEventListener('error', () => image.remove(), { once: true });
    imageLink.append(image);
    const copy = document.createElement('div'); copy.className = 'store-prod-body';
    const top = document.createElement('div');
    if (live && live.sku) { const sku = document.createElement('div'); sku.className = 'store-prod-sku'; sku.textContent = 'SKU: ' + live.sku; top.append(sku); }
    const title = document.createElement('h3'); title.className = 'store-prod-title';
    const titleLink = document.createElement('a'); titleLink.href = href; titleLink.textContent = product.name; title.append(titleLink);
    top.append(title);
    const bottom = document.createElement('div');
    if (live && Number.isFinite(Number(live.price)) && Number(live.price) > 0) { const price = document.createElement('div'); price.className = 'store-prod-price'; price.textContent = money(live.price); bottom.append(price); }
    const action = document.createElement('button'); action.type = 'button'; action.className = 'store-prod-btn';
    action.dataset.label = CART_LABEL; action.textContent = CART_LABEL;
    const status = document.createElement('p'); status.className = 'cms-cart-status'; status.setAttribute('role', 'status');
    action.addEventListener('click', () => window.cmsAddToCart(product, action, status));
    const view = document.createElement('a'); view.className = 'store-prod-view'; view.href = href; view.textContent = 'Ver producto';
    bottom.append(action, status, view);
    copy.append(top, bottom);
    card.append(imageLink, copy);
    return card;
  }
  async function loadProducts() {
    try {
      const response=await fetch('/data/cms-products.json',{signal:AbortSignal.timeout(20000)});
      if(!response.ok) throw new Error('catalog');
      const data=await response.json();
      const productIds=JSON.parse(grid?.dataset.productIds || '[]');
      // Promo/paquete bundles belong only in the dedicated promotions section,
      // never mixed into the regular product catalog grid.
      const pool=(data.products || []).filter(p=>!/promo|paquete/.test(norm(p.name))).map(product=>({product,score:terms.reduce((score,term)=>score+(norm(product.name).includes(term)?3:0),0)}));
      const matched=pool.filter(item=>item.score>0).sort((a,b)=>b.score-a.score);
      // Every page should be able to fill 5 rows (20 products). Themes with
      // few real matches (e.g. boda, xv) top up with the next best-ranked
      // general products instead of leaving the page with only 1-2 rows.
      const MIN_PRODUCTS=20;
      const topped=matched.length>=MIN_PRODUCTS ? matched : matched.concat(pool.filter(item=>item.score===0).slice(0,MIN_PRODUCTS-matched.length));
      const selected=productIds.length ? productIds.map(id=>({product:(data.products||[]).find(p=>p.id===id)})).filter(item=>item.product) : topped.slice(0,30);
      const promos=(data.products||[]).filter(p=>/promo|paquete/.test(norm(p.name)) && terms.some(t=>norm(p.name).includes(t)));
      const shown=[...(grid?selected.map(item=>item.product):[]),...(promoGrid?promos:[])];
      const liveMap=shown.length ? await fetchLive([...new Set(shown.map(p=>p.id))]) : new Map();
      // Si la consulta respondió, un producto que no aparece ya no está activo: no se muestra.
      const build=product=>{const live=liveMap.get(Number(product.id));return liveMap.size&&!live?null:productCard(product,live);};
      if(promoGrid){
        const promoCards=promos.map(build).filter(Boolean);
        const promoFull=promoCards.length>=4 ? Math.floor(promoCards.length/4)*4 : promoCards.length;
        promoGrid.replaceChildren(...promoCards.slice(0,promoFull));
        promoGrid.hidden=!promoCards.length;
      }
      if(!grid)return;
      const cards=selected.map(item=>build(item.product)).filter(Boolean);
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
