const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const cheerio=require('cheerio');
const root=path.resolve(__dirname,'..');
const source=require('../data/cms-pages.json'),manifest=require('../data/cms-manifest.json');
const config=require('../vercel.json');
const {modelFor,sanitize,locationLinks,cityOf}=require('../scripts/cms-content.cjs');
const handler=require('../api/paginas.js');
function response(){return {code:0,data:null,headers:{},setHeader(k,v){this.headers[k]=v},status(code){this.code=code;return this},json(data){this.data=data;return this},send(data){this.data=data;return this}};}
test('every source page has its exact title, slug, original path and static metadata',()=>{
  assert.equal(source.length,152);assert.equal(manifest.length,source.length);
  for(const page of source){
    const m=manifest.find(p=>p.id===page.id);assert.equal(m.slug,page.slug);
    assert.equal(m.path,`/content/${page.id}-${page.slug}`);
    const route=config.rewrites.find(r=>r.source===m.path);assert.ok(route,m.path);
    const $=cheerio.load(fs.readFileSync(path.join(root,route.destination),'utf8'));
    assert.equal($('h1').length,1,m.path);assert.equal($('h1').text(),page.title);
    assert.equal($('link[rel=canonical]').attr('href'),'https://mifiestashop.vercel.app'+m.path);
    assert.equal($('title').text(),page.title+' | Mi Fiestashop');
    assert.equal($('meta[name=description]').length,1);
    assert.equal($('script:not([src]):not([type="application/ld+json"])').length,0);
  }
});
test('aliases preserve duplicate IDs, misspellings and trailing hyphens without collisions',()=>{
  const first=new Map();for(const p of source)if(!first.has(p.slug))first.set(p.slug,p);
  assert.equal(first.size,140);
  for(const [slug,p]of first)for(const prefix of ['/','/pagina/'])assert.equal(config.rewrites.find(r=>r.source===prefix+slug)?.destination,`/cms-pages/${p.id}.html`);
  for(const slug of ['accesorios-para-batucada-boda-','accesorios-para-fiesta-cdmx-','articulos-pata-batucada-en-cdmx'])assert.ok(first.has(slug));
  const exact=config.rewrites.map(r=>r.source);assert.equal(new Set(exact).size,exact.length);
  assert.notEqual(config.rewrites.find(r=>r.source==='/content/322-venta-de-articulos-de-fiesta-puebla').destination,config.rewrites.find(r=>r.source==='/content/328-venta-de-articulos-de-fiesta-puebla').destination);
});
test('locations require source evidence and always match the page city',()=>{
  for(const p of source){
    const model=modelFor(p,source),$=cheerio.load(fs.readFileSync(path.join(root,`cms-pages/${p.id}.html`),'utf8'));
    if(!locationLinks(p.sourceContent).length){assert.equal(model.location,null,p.slug);assert.equal($('#ubicacion').length,0,p.slug);assert.equal($('script[type="application/ld+json"]').text().includes('contentLocation'),false,p.slug);}
    if(model.location){const expected=cityOf(p.title+' '+p.slug);if(expected)assert.equal(model.location.city,expected,p.slug);assert.ok(model.location.evidence.sourceHadLocation);}
  }
  const qro=modelFor(source.find(p=>p.id===281),source);assert.match(qro.location.address,/Lázaro Cárdenas 67/);
  const puebla=modelFor(source.find(p=>p.id===395),source);assert.equal(puebla.location.city,'puebla');assert.match(puebla.location.address,/35 Sur 2901/);assert.equal(puebla.location.corrected,true);
  assert.equal(modelFor(source.find(p=>p.id===333),source).location,null);
  assert.equal(modelFor(source.find(p=>p.id===385),source).location,null);
});
test('subjects follow the source title, including narrow topics',()=>{
  const expected={281:'boda',274:'xv',302:'neon',303:'pintura',365:'polvo',333:'sombreros',315:'cumpleanos',411:'globos',412:'informacion',9:'bicicletas'};
  for(const [id,theme]of Object.entries(expected))assert.equal(modelFor(source.find(p=>p.id===Number(id)),source).theme,theme);
  assert.doesNotMatch(fs.readFileSync(path.join(root,'cms-pages/281.html'),'utf8'),/fiesta de XV años/i);
});
test('copied Puebla marketing copy no longer promotes CDMX and product links use current IDs',()=>{
  const html=fs.readFileSync(path.join(root,'cms-pages/395.html'),'utf8');
  const $=cheerio.load(html);assert.doesNotMatch($('.source-content').text(),/CDMX|Ciudad de M[eé]xico|Quer[eé]taro/i);
  assert.ok($('.source-content a[href="/83553-promo-batucada-estandar-.html"]').length);
});
test('all retained CMS images are local and exist; unavailable originals are omitted',()=>{
  for(const p of source){const $=cheerio.load(fs.readFileSync(path.join(root,`cms-pages/${p.id}.html`),'utf8'));$('.hero img,.source-content img').each((_,e)=>{const src=$(e).attr('src');assert.ok(src.startsWith('/img/'),`${p.id}: ${src}`);assert.ok(fs.existsSync(path.join(root,src)),src)});}
});
test('CMS API serves migrated content by exact ID/slug, without a PrestaShop key',()=>{
  for(const id of [281,322,328,385]){const res=response();handler({query:{id:String(id)}},res);assert.equal(res.code,200);assert.equal(res.data.page.id,id);assert.equal(res.data.page.migrated,true);assert.ok(res.data.page.content);}
  let res=response();handler({query:{slug:'accesorios-para-batucada-boda-'}},res);assert.equal(res.code,200);assert.equal(res.data.page.slug,'accesorios-para-batucada-boda-');
  res=response();handler({query:{slug:'does-not-exist'}},res);assert.equal(res.code,404);
  res=response();handler({query:{all:'1'}},res);assert.equal(res.data.pages.length,152);assert.equal(res.data.pages[0].content,undefined);
  res=response();handler({query:{}},res);assert.ok(res.data.pages.every(p=>p.inFooter));
});
test('contact page preserves all four original maps and VIP pages retain their form integrations',()=>{
  const $=cheerio.load(fs.readFileSync(path.join(root,'cms-pages/418.html'),'utf8'));
  assert.equal($('.source-content a[href]').filter((_,e)=>/maps/.test($(e).attr('href'))).length,4);
  assert.match($('.source-content').text(),/Rumania 613-C/);assert.match($('.source-content').text(),/Rio San Javier 29/);
  for(const id of [294,295,296]){const page=source.find(p=>p.id===id);const form=cheerio.load(fs.readFileSync(path.join(root,`cms-pages/${id}.html`),'utf8'));assert.equal(form('#vip-form').attr('data-endpoint'),page.vip.endpoint);assert.equal(form('#vip-form').attr('data-redirect'),page.vip.redirect);assert.equal(form('#vip-form input').length,3);assert.equal(form('#ubicacion').length,0);}
});
test('sitemap includes all original CMS paths even without a PrestaShop key',async()=>{
  const prev=process.env.PS_API_KEY;delete process.env.PS_API_KEY;
  try{const res=response();await require('../api/sitemap.js')({query:{}},res);assert.equal(res.code,200);for(const page of source)assert.ok(res.data.includes(`https://mifiestashop.vercel.app${page.sourcePath}`));}
  finally{if(prev!==undefined)process.env.PS_API_KEY=prev;}
});
test('imported markup cannot execute old builder scripts or change document base',()=>{
  const p=source[0];const html=sanitize('<base href="https://evil.example"><script>alert(1)</script><p onclick="bad()">Texto</p><img src="javascript:bad()" onerror="bad()"><a href="javascript:bad()">Leer</a><iframe src="https://evil.example"></iframe>',p,source,null);
  assert.doesNotMatch(html,/<script|<base|onclick|onerror|javascript:|<iframe/i);assert.match(html,/Texto/);
});
test('storefront and CMS JavaScript compile',()=>{
  const $=cheerio.load(fs.readFileSync(path.join(root,'index.html'),'utf8'));
  $('script:not([src])').each((_,el)=>{if(!$(el).attr('type')||$(el).attr('type')==='text/javascript')new vm.Script($(el).html());});
  new vm.Script(fs.readFileSync(path.join(root,'assets/cms.js'),'utf8'));
  new vm.Script(fs.readFileSync(path.join(root,'assets/cms-vip.js'),'utf8'));
});
