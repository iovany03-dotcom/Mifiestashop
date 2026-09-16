// Migrated CMS pages are versioned in this repository, independent of PrestaShop.
const pages = require('../data/cms-runtime.json');
const legacy = require('../lib/prestashop-pages.js');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const {id, slug, all} = req.query || {};
  if (id || slug) {
    const page = id ? pages.find(p=>String(p.id)===String(id)) : pages.find(p=>p.slug===slug);
    if (!page) {
      if (!process.env.PS_API_KEY) return res.status(404).json({error:'Página no encontrada'});
      return legacy(req,res);
    }
    return res.status(200).json({page});
  }
  const migrated=pages.map(({content,description,...page})=>page);
  if(!process.env.PS_API_KEY)return res.status(200).json({pages:all?migrated:[]});
  let code=200;
  const proxy={
    setHeader:(key,value)=>res.setHeader(key,value),
    status(status){code=status;return proxy},
    json(data){
      if(!Array.isArray(data.pages))return res.status(code).json(data);
      const result=data.pages.map(page=>migrated.find(p=>String(p.id)===String(page.id))||page);
      if(all)for(const page of migrated)if(!result.some(p=>String(p.id)===String(page.id)))result.push(page);
      return res.status(code).json({...data,pages:result});
    }
  };
  return legacy(req,proxy);
};
