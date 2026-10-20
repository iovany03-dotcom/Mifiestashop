// Vercel serverless function: paquetes de promoción (Jr/Estándar/VIP) por id, desde
// catalogo_productos, para la tabla de precios de las páginas CMS de promociones. Precio
// y lista de artículos salen siempre del catálogo — fijarlos en las páginas estáticas
// dejaría de ser cierto en cuanto cambie un precio real.

// The "Esta promo incluye" lead-in and the "*Stock sujeto a bodega*" disclaimer are
// boilerplate around the real list, not items themselves — the card already renders
// its own stock note for VIP tiers, so these are dropped to avoid duplicating them.
function isBoilerplateLine(line) {
  return /^esta promo (te )?incluye\b|^\*?\s*(stock|contenido)\s+sujeto\s+a/i.test(line.trim());
}

// A package's real content list usually comes as <li> bullets in the product
// description; each <li> becomes one item. If the description has no list markup,
// it falls back to one item per line/sentence so short prose still renders as a list.
function itemsFromDescription(html) {
  const liMatches = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => m[1].replace(/<[^>]*>/g, '').trim()).filter(Boolean);
  const list = liMatches.length ? liMatches : html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, '').trim().split(/\n+/).map(s => s.trim()).filter(Boolean);
  return list.filter(line => line && !isBoilerplateLine(line));
}

// The product's real "Esta promo incluye" item list lives in the long description
// (the "Descripción" tab on the product page) — description_short is just a generic
// one-liner ("Articulos para boda") shown next to the price. Long description wins
// whenever it actually parses into a real list; description_short is only a fallback
// for products that never got the long description filled in.
function pickItems(shortDesc, longDesc) {
  const longItems = itemsFromDescription(longDesc);
  if (longItems.length >= 2) return longItems;
  const shortItems = itemsFromDescription(shortDesc);
  if (shortItems.length >= 2) return shortItems;
  return longItems.length ? longItems : shortItems;
}

// Last-resort fallback, transcribed straight from the live site at the owner's
// request, for the rare product whose description has no real list at all. The
// moment the product's own description is filled in, that one wins.
const FALLBACK_ITEMS = {
  83589: ['200 Globos salchicha', '50 Pulseras luminosas cyalume', '2 Lentes gigante', '3 Collares hawaianos', '2 Antifaces de cartón metálico', '3 Micrófonos inflables', '3 Guitarras metálicas inflables', '2 Cornetas con mechudo', '2 Letreros selfie', '2 Antifaz carnaval', '2 Mandiles personalizados', '1 Sombrero novia hule espuma', '1 Sombrero novio hule espuma'],
  83552: ['5 Antifaz de cartón metálico', '5 Pelucas metálicas', '1 Globo salchicha (200 pzas)', '2 Micrófonos inflables chicos', '4 Guitarras metálicas inflables', '3 Bombines con peluca metálica', '2 Lentes batucada', '6 Collares de perla', '7 Diademas con pelitos', '2 Sombreros de palma', '1 Máscara de luchador', '5 Corbatas neón', '5 Moños neón', '5 Bombines neón', '2 Lentes gigantes neón', '6 Collares hawaianos neón', '1 Sombrero de hule espuma Novio', '1 Sombrero de hule espuma Novio', '5 Diademas con mechudo', '5 Letreros selfie boda', '1 Pulsera luminosa cyalume (90 pzas)', '4 Lentes luminosos cyalume', '1 Anillo luminoso LED (4 pzas)'],
  83591: ['8 Antifaz cartón metálico', '6 Peluca metálica', '1 Globo salchicha (200 pzas)', '5 Micrófono inflable chico', '5 Guitarra metálica inflable', '2 Peluca afro negra', '5 Mandil con frases divertidos', '4 Bombín con peluca metálica', '6 Lente batucada', '1 Corona Princesa', '5 Collar perla', '6 Diadema con pelitos', '2 Bombín con pelo', '3 Peluca corta', '4 Sombrero de palma', '2 Lente antifaz gigante', '6 Corbata neón', '6 Bombín neón', '4 Gorra neón', '5 Lente gigante neón', '10 Collar hawaiano', '6 Antifaz neón de PVC', '6 Corneta neón', '8 Sombrero Divertido de hule espuma', '1 Sombrero de hule espuma Novio', '1 Sombrero de hule espuma Novia', '8 Diadema con mechudo', '1 Espanta suegras (100 pzas)', '5 Antifaz Carnaval', '5 Letrero selfie boda', '1 Pulsera cyalume (90 pzas)', '5 Lente luminoso cyalume', '2 Coronas de flores luminosa LED', '2 Diadema conejo luminoso LED', '1 Anillo luminosa LED (4 pzas)', '4 Lente luminoso LED', '6 Anillo de goma luminoso LED', '5 Diadema luminosa cyalume']
};

const { fetchCatalogoByIds } = require('../lib/catalogo-productos.js');

// catalogo_productos guarda la descripción ya sin HTML (con saltos de
// línea). Cuando el encabezado "Esta promo incluye 🥳" venía en su propio
// <p>, al quitar las etiquetas queda pegado al primer artículo ("…🥳5
// Antifaz…") — se separa para que no se descarte ese artículo junto con él.
function splitPromoLead(text) {
  return String(text || '').replace(/^(\s*esta promo (?:te )?incluye[^\d\n]*?)(?=\d)/i, '$1\n');
}

// Los ids que vienen de PrestaShop caben en 32 bits (y tienen su página
// /{id}-{link_rewrite}.html); los productos propios usan ids mucho más grandes.
const MAX_PS_ID = 4294967295;
const SITE_URL = 'https://www.mifiestashop.com';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s));
  if (!ids.length) {
    res.status(400).json({ error: 'Falta el parámetro ids', packages: [] });
    return;
  }

  try {
    const rows = await fetchCatalogoByIds(ids);
    const byId = new Map(rows.map(r => [String(r.id), r]));
    const packages = ids.filter(id => byId.has(id)).map(id => {
      const row = byId.get(id);
      const liveItems = pickItems(splitPromoLead(row.description_short), splitPromoLead(row.description));
      const isPs = Number(row.id) <= MAX_PS_ID;
      return {
        id: Number(row.id),
        name: row.name,
        price: Number(row.price) || 0,
        items: liveItems.length >= 2 ? liveItems : (FALLBACK_ITEMS[row.id] || liveItems),
        img: (Array.isArray(row.images) && row.images[0]) || '',
        linkRewrite: row.link_rewrite || '',
        url: isPs && row.link_rewrite ? `${SITE_URL}/${row.id}-${row.link_rewrite}.html` : undefined
      };
    });
    res.status(200).json({ packages });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al consultar los paquetes en Supabase', detail: String(err), packages: [] });
  }
};
