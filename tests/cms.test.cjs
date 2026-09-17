const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const cheerio=require('cheerio');
const root=path.resolve(__dirname,'..');
const source=require('../data/cms-pages.json'),manifest=require('../data/cms-manifest.json');
const config=require('../vercel.json');
const {modelFor,sanitize,locationLinks,cityOf}=require('../scripts/cms-content.cjs');
const handler=require('../api/paginas.js');
function response(){return {code:0,data:null,headers:{},setHeader(k,v){this.headers[k]=v},status(code){this.code=code;return this},json(data){this.data=data;return this},send(data){this.data=data;return this}};}
test('every source page has its exact title, slug, original path and static metadata',()=>{
  assert.equal(source.length,139);assert.equal(manifest.length,source.length);
  for(const page of source){
    const m=manifest.find(p=>p.id===page.id);assert.equal(m.slug,page.slug);
    assert.equal(m.path,`/content/${page.id}-${page.slug}`);
    const route=config.rewrites.find(r=>r.source===m.path);assert.ok(route,m.path);
    const $=cheerio.load(fs.readFileSync(path.join(root,route.destination),'utf8'));
    assert.equal($('h1').length,1,m.path);assert.equal($('h1').text(),page.id===410?page.title.replace(/_+$/,''):page.title);
    assert.equal($('link[rel=canonical]').attr('href'),'https://mifiestashop.vercel.app'+m.path);
    assert.equal($('title').text(),page.title+' | Mi Fiestashop');
    assert.equal($('meta[name=description]').length,1);
    assert.equal($('script:not([src]):not([type="application/ld+json"])').length,0);
  }
});
test('aliases preserve duplicate IDs, misspellings and trailing hyphens without collisions',()=>{
  const first=new Map();for(const p of source)if(!first.has(p.slug))first.set(p.slug,p);
  assert.equal(first.size,127);
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
  const expected={281:'boda',274:'xv',302:'neon',303:'pintura',365:'polvo',333:'sombreros',315:'cumpleanos',411:'globos'};
  for(const [id,theme]of Object.entries(expected))assert.equal(modelFor(source.find(p=>p.id===Number(id)),source).theme,theme);
  assert.doesNotMatch(fs.readFileSync(path.join(root,'cms-pages/281.html'),'utf8'),/fiesta de XV años/i);
});
test('copied Puebla marketing copy no longer promotes CDMX; legacy builder content is not rendered',()=>{
  const html=fs.readFileSync(path.join(root,'cms-pages/395.html'),'utf8');
  // Excludes "Más ideas para tu fiesta": those are legitimate cross-links to
  // other cities' pages, not copied marketing copy for this one.
  const $=cheerio.load(html);$('.related-pages').remove();assert.doesNotMatch($('main').text(),/CDMX|Ciudad de M[eé]xico|Quer[eé]taro/i);
  // Non-informational pages no longer render the imported builder content
  // (old banners, stock photos, promo package copy) at all — only the
  // shared modern sections (hero, benefits, catalog, reviews, FAQ) show.
  assert.equal($('.source-content').length, 0);
});
test('all retained CMS images are local and exist; unavailable originals are omitted',()=>{
  for(const p of source){const $=cheerio.load(fs.readFileSync(path.join(root,`cms-pages/${p.id}.html`),'utf8'));$('.hero img,.source-content img').each((_,e)=>{const src=$(e).attr('src');assert.ok(src.startsWith('/img/'),`${p.id}: ${src}`);assert.ok(fs.existsSync(path.join(root,src)),src)});}
});
test('CMS API serves migrated content by exact ID/slug, without a PrestaShop key',()=>{
  for(const id of [281,322,328,385]){const res=response();handler({query:{id:String(id)}},res);assert.equal(res.code,200);assert.equal(res.data.page.id,id);assert.equal(res.data.page.migrated,true);assert.ok(res.data.page.content);}
  let res=response();handler({query:{slug:'accesorios-para-batucada-boda-'}},res);assert.equal(res.code,200);assert.equal(res.data.page.slug,'accesorios-para-batucada-boda-');
  res=response();handler({query:{slug:'does-not-exist'}},res);assert.equal(res.code,404);
  res=response();handler({query:{all:'1'}},res);assert.equal(res.data.pages.filter(p=>p.migrated).length,139);assert.equal(res.data.pages[0].content,undefined);
  res=response();handler({query:{}},res);assert.ok(res.data.pages.every(p=>p.inFooter));
});
test('only Facebook and Google pages are migrated; VIP forms keep their original integration',()=>{
  assert.equal(source.filter(p=>p.categoryId===33).length,26);assert.equal(source.filter(p=>p.categoryId===34).length,113);
  for(const id of [9,11,12,412,413,414,415,416,417,418,419,420,421])assert.equal(fs.existsSync(path.join(root,'cms-pages/'+id+'.html')),false);
  for(const id of [294,295,296]){const page=source.find(p=>p.id===id);const form=cheerio.load(fs.readFileSync(path.join(root,'cms-pages/'+id+'.html'),'utf8'));assert.equal(form('#vip-form').attr('data-endpoint'),page.vip.endpoint);assert.equal(form('#vip-form').attr('data-redirect'),page.vip.redirect);assert.equal(form('#vip-form input').length,3);}
});
test('sitemap includes all original CMS paths even without a PrestaShop key',async()=>{
  const prev=process.env.PS_API_KEY;delete process.env.PS_API_KEY;
  try{const res=response();await require('../api/sitemap.js')({query:{}},res);assert.equal(res.code,200);for(const page of source)assert.ok(res.data.includes(`https://mifiestashop.vercel.app${page.sourcePath}`));}
  finally{if(prev!==undefined)process.env.PS_API_KEY=prev;}
});
test('excluded pages keep their original PrestaShop response and coexist with migrated pages',async()=>{
  const previousFetch=global.fetch,previousKey=process.env.PS_API_KEY;
  process.env.PS_API_KEY='test-only';
  const legal={id:420,meta_title:'Política de Envío Gratis Mi Fiesta Shop',link_rewrite:'politica-de-envio-gratis-mi-fiesta-shop',active:1,content:'<p>Contenido original</p>'};
  global.fetch=async()=>({ok:true,json:async()=>({content_management_system:[legal]})});
  try {
    let res=response();await handler({query:{id:'420'}},res);assert.equal(res.data.page.content,legal.content);assert.equal(res.data.page.migrated,undefined);
    res=response();await handler({query:{all:'1'}},res);assert.equal(res.data.pages.length,149);assert.ok(res.data.pages.every(p=>![9,11,12].includes(Number(p.id))));assert.equal(res.data.pages.filter(p=>p.migrated).length,139);
    res=response();await handler({query:{}},res);assert.equal(res.data.pages.length,1);assert.equal(res.data.pages[0].id,420);
  }finally{global.fetch=previousFetch;if(previousKey===undefined)delete process.env.PS_API_KEY;else process.env.PS_API_KEY=previousKey;}
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

test('migrated pages and admin inventory work without PrestaShop network access',async()=>{
 const oldFetch=global.fetch;global.fetch=()=>{throw new Error('PrestaShop offline')};
 try{const res=response();await handler({query:{all:'1'}},res);assert.equal(res.code,200);assert.equal(res.data.pages.filter(p=>p.migrated).length,139);}finally{global.fetch=oldFetch;}
 for(const p of source){const $=cheerio.load(fs.readFileSync(path.join(root,'cms-pages/'+p.id+'.html'),'utf8'));$('img').each((_,el)=>{const src=$(el).attr('src');assert.ok(src.startsWith('/img/'),src);assert.ok(fs.existsSync(path.join(root,src)));});}
 const catalog=require('../data/cms-products.json');assert.ok(catalog.products.length>0);for(const p of catalog.products){assert.ok(fs.existsSync(path.join(root,p.img)));assert.equal(p.price,undefined);}
 const js=fs.readFileSync(path.join(root,'assets/cms.js'),'utf8');assert.doesNotMatch(js,/mifiestashop\.com|api\/productos/);assert.match(js,/data\/cms-products\.json/);
});

test('neon redesign is isolated and imported icon/location banners cannot reappear',()=>{
 const removed=['b7b3e512c4029e40','69f29cc0e2aaaeb0','6eeaeb9d458892c4'];
 for(const page of source){const html=fs.readFileSync(path.join(root,'cms-pages/'+page.id+'.html'),'utf8');const $=cheerio.load(html);assert.equal($('body').hasClass('neon-page'),page.id===410);for(const id of removed)assert.ok(!$('.source-content').html()?.includes(id),page.slug);$('script[src],link[rel=stylesheet]').each((_,e)=>{const u=$(e).attr('src')||$(e).attr('href');if(u.startsWith('/assets/'))assert.match(u,/\?v=[a-f0-9]{12}$/);});}
 const html=fs.readFileSync(path.join(root,'cms-pages/410.html'),'utf8');assert.ok(html.includes('Rumania 613'));assert.ok(!html.includes('Puebla'));new vm.Script(fs.readFileSync(path.join(root,'assets/neon-cdmx.js'),'utf8'));
});
