// All public CMS content is versioned locally, including information pages.
const pages = require('../data/cms-runtime.json');
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { id, slug, all } = req.query || {};
  if (id || slug) {
    const page = id ? pages.find(page => String(page.id) === String(id)) : pages.find(page => page.slug === slug);
    return page ? res.status(200).json({ page }) : res.status(404).json({ error: 'Página no encontrada' });
  }
  return res.status(200).json({ pages: pages.filter(page => all || page.inFooter).map(({ content, description, ...page }) => page) });
};
