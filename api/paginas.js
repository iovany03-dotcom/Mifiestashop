// Migrated CMS pages are versioned in this repository, independent of PrestaShop.
const pages = require('../data/cms-runtime.json');
const legacyIndexRaw = require('../data/cms-legacy-index.json');
const legacy = require('../lib/prestashop-pages.js');

// Páginas que se ocultan de nuestro propio sistema (admin, footer y acceso
// directo) sin tocar ni borrar nada en PrestaShop.
const HIDDEN_PAGE_IDS = ['9', '11', '12'];
const HIDDEN_PAGE_SLUGS = ['bicicletas', 'hogar', 'herramientas'];
const legacyIndex = legacyIndexRaw.filter(p => !HIDDEN_PAGE_IDS.includes(String(p.id)));

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
      if (!process.env.PS_API_KEY) return res.status(404).json({error:'Página no encontrada'});
      return legacy(req,res);
    }
    return res.status(200).json({page});
  }
  const migrated=pages.map(({content,description,...page})=>page);
  if(all)return res.status(200).json({pages:[...legacyIndex,...migrated]});
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
