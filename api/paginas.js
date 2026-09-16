// Migrated CMS pages are versioned in this repository, independent of PrestaShop.
const pages = require('../data/cms-runtime.json');
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const {id, slug, all} = req.query || {};
  if (id || slug) {
    const page = id ? pages.find(p=>String(p.id)===String(id)) : pages.find(p=>p.slug===slug);
    if (!page) return res.status(404).json({error:'Página no encontrada'});
    return res.status(200).json({page});
  }
  return res.status(200).json({pages:pages.filter(p=>all || p.inFooter).map(({content, description, ...page})=>page)});
};
