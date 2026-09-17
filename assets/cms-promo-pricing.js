(() => {
  'use strict';
  const grid = document.getElementById('cms-promo-pricing');
  if (!grid) return;
  let packages;
  try { packages = JSON.parse(grid.dataset.packages || '[]'); } catch { packages = []; }
  if (!packages.length) return;

  const money = n => Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0 });
  const BADGES = { Jr: 'Básico', Estándar: 'Recomendado', VIP: 'Todo incluido' };

  function card(pkg, live) {
    const el = document.createElement('article');
    el.className = 'promo-pricing-card' + (pkg.tier === 'Estándar' ? ' featured' : '') + (pkg.tier === 'VIP' ? ' tier-dark' : '');
    const badge = document.createElement('span'); badge.className = 'promo-pricing-badge'; badge.textContent = BADGES[pkg.tier] || pkg.tier;
    const title = document.createElement('h3'); title.className = 'promo-pricing-title'; title.textContent = live.name || ('Paquete ' + pkg.tier);
    const price = document.createElement('div'); price.className = 'promo-pricing-price'; price.textContent = money(live.price);
    const note = document.createElement('p'); note.className = 'promo-pricing-note'; note.textContent = 'Sin IVA';
    const shipping = document.createElement('p'); shipping.className = 'promo-pricing-shipping'; shipping.textContent = '🚚 Envío gratis en compras +$1,500';
    const list = document.createElement('ul'); list.className = 'promo-pricing-items';
    live.items.forEach(item => { const li = document.createElement('li'); li.textContent = item; list.append(li); });
    const action = document.createElement('button'); action.type = 'button'; action.className = 'promo-pricing-btn'; action.textContent = 'Agregar al carrito';
    const status = document.createElement('p'); status.className = 'cms-cart-status'; status.setAttribute('role', 'status');
    action.addEventListener('click', () => window.cmsAddToCart({ id: live.id, name: live.name, img: live.img }, action, status));
    el.append(badge, title, price, note, shipping, list);
    if (pkg.tier === 'VIP') { const stock = document.createElement('p'); stock.className = 'promo-pricing-stock'; stock.textContent = '*Stock sujeto a bodega'; el.append(stock); }
    el.append(action, status);
    return el;
  }

  async function load() {
    try {
      const ids = packages.map(p => p.id).join(',');
      const response = await fetch('/api/promo-paquetes?ids=' + ids, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('promo-paquetes');
      const data = await response.json();
      const byId = new Map((data.packages || []).map(p => [p.id, p]));
      const cards = packages.map(p => ({ pkg: p, live: byId.get(p.id) })).filter(c => c.live);
      if (!cards.length) { grid.remove(); return; }
      grid.replaceChildren(...cards.map(c => card(c.pkg, c.live)));
    } catch {
      grid.remove();
    }
  }
  load();
})();
