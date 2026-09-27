// Migrated CMS pages are versioned in this repository, independent of PrestaShop.
const pages = require('../data/cms-runtime.json');
const legacyIndexRaw = require('../data/cms-legacy-index.json');
const legacy = require('../lib/prestashop-pages.js');
const { prestashopConectado, sbGetAll } = require('../lib/prestashop.js');

// Páginas que se ocultan de nuestro propio sistema (admin, footer y acceso
// directo) sin tocar ni borrar nada en PrestaShop.
const HIDDEN_PAGE_IDS = ['9', '11', '12', '412', '413', '415', '416', '417', '419'];
const HIDDEN_PAGE_SLUGS = ['bicicletas', 'hogar', 'herramientas', 'entrega', 'aviso-legal', 'sobre-nosotros', 'pago-seguro', 'articulos-para-fiesta-mayoreo-en-mexico', 'productos-con-descuentos'];
const legacyIndex = legacyIndexRaw.filter(p => !HIDDEN_PAGE_IDS.includes(String(p.id)));

// PrestaShop desconectado (default, ver lib/prestashop.js): las páginas que
// no están migradas al repo salen de ps_cms_paginas, la copia que el cron
// sincroniza cada hora desde PrestaShop — mismas reglas de título y de
// texto de respaldo que el camino en vivo (lib/prestashop-pages.js).
const { normalize, titleFromSlug, isGenericTitle, fallbackContentFor, FOOTER_PAGE_KEYWORDS } = legacy.helpers;

function pageTitle(row) {
  const raw = row.title || '';
  return isGenericTitle(raw) ? titleFromSlug(row.slug || '') : raw;
}

async function syncedPages() {
  try {
    return await sbGetAll('ps_cms_paginas?select=id,slug,title,description,content,active&active=eq.true&order=id.asc');
  } catch (e) {
    return [];
  }
}

async function pageFromSupabase(id, slug) {
  const rows = await syncedPages();
  const row = rows.find(p => (id && String(p.id) === String(id)) || (slug && p.slug === slug));
  if (row) {
    const title = pageTitle(row);
    const content = row.content && row.content.trim() ? row.content : fallbackContentFor(title);
    return { id: String(row.id), title, description: row.description || '', content, slug: row.slug || '' };
  }
  // Sin copia sincronizada todavía: título real del índice versionado en el
  // repo y el mismo texto de respaldo que se usaba cuando PrestaShop venía
  // vacío.
  const entry = legacyIndex.find(p => (id && String(p.id) === String(id)) || (slug && p.slug === slug));
  if (!entry) return null;
  return { id: String(entry.id), title: entry.title, description: '', content: fallbackContentFor(entry.title), slug: entry.slug };
}

async function footerPagesFromSupabase(migrated) {
  const rows = await syncedPages();
  const pages = rows.length
    ? rows
      .map(p => ({ id: String(p.id), title: pageTitle(p), slug: p.slug || '' }))
      .filter(p => p.slug && !HIDDEN_PAGE_IDS.includes(String(p.id)))
      .filter(p => FOOTER_PAGE_KEYWORDS.some(kw => normalize(p.title).includes(kw)))
    : legacyIndex.filter(p => p.inFooter);
  return pages.map(page => migrated.find(p => String(p.id) === String(page.id)) || page);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const {id, slug, all} = req.query || {};
  if (id || slug) {
    if ((id && HIDDEN_PAGE_IDS.includes(String(id))) || (slug && HIDDEN_PAGE_SLUGS.includes(slug))) {
      return res.status(404).json({error:'Página no encontrada'});
    }
    const page = id ? pages.find(p=>String(p.id)===String(id)) : pages.find(p=>p.slug===slug);
    if (!page) {
      if (!prestashopConectado()) {
        const synced = await pageFromSupabase(id, slug);
        return synced ? res.status(200).json({page: synced}) : res.status(404).json({error:'Página no encontrada'});
      }
      if (!process.env.PS_API_KEY) return res.status(404).json({error:'Página no encontrada'});
      return legacy(req,res);
    }
    return res.status(200).json({page});
  }
  const migrated=pages.map(({content,description,...page})=>page);
  if(all)return res.status(200).json({pages:[...legacyIndex,...migrated]});
  if(!prestashopConectado())return res.status(200).json({pages:await footerPagesFromSupabase(migrated)});
  if(!process.env.PS_API_KEY)return res.status(200).json({pages:all?migrated:[]});
  let code=200;
  const proxy={
    setHeader:(key,value)=>res.setHeader(key,value),
    status(status){code=status;return proxy},
    json(data){
      if(!Array.isArray(data.pages))return res.status(code).json(data);
      const result=data.pages
        .filter(page=>!HIDDEN_PAGE_IDS.includes(String(page.id)))
        .map(page=>migrated.find(p=>String(p.id)===String(page.id))||page);
      if(all)for(const page of migrated)if(!result.some(p=>String(p.id)===String(page.id)))result.push(page);
      return res.status(code).json({...data,pages:result});
    }
  };
  return legacy(req,proxy);
};
