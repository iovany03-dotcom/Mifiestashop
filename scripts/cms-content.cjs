const cheerio = require('cheerio');
const { normalize, THEMES, themeFor } = require('./cms-themes.cjs');
const SOURCE_ORIGIN = 'https://mifiestashop.com';
const productLinks = require('../data/cms-product-links.json');
const fs = require('node:fs');
const path = require('node:path');
const assetFile = path.join(__dirname,'../data/cms-assets.json');
const assets = fs.existsSync(assetFile) ? JSON.parse(fs.readFileSync(assetFile)) : {};
function assetUrl(src, page) {
  const alias = Object.entries(page.assetAliases || {}).find(([key])=>absolute(key)===absolute(src));
  const url = page.assetAliases?.[src] || alias?.[1] || absolute(src);
  return assets[url] ? (assets[url].path || '') : url;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const text = ($, node) => $(node).text().replace(/\s+/g, ' ').trim();
const cityOf = value => {
  const n = normalize(value);
  return /queretaro|\bqro\b|20\.577|4425967511/.test(n) ? 'queretaro'
    : /puebla|19\.046|35\+? sur/.test(n) ? 'puebla'
    : /atizapan|19\.563/.test(n) ? 'atizapan'
    : /cdmx|ciudad de mexico|19\.365|rumania|oQPABhGofckY9knv6/i.test(n) ? 'cdmx' : null;
};
// Addresses verified in the original store footer; maps verified in the CMS body.
// These are only used when that page already has a location, never from its title alone.
const STORES = {
  queretaro: { name: 'Querétaro', address: 'C. Gral. Lázaro Cárdenas 67, Casa Blanca', sourceId: 281 },
  puebla: { name: 'Puebla', address: 'C. 35 Sur 2901, Sta. Cruz Los Ángeles', sourceId: 282 },
  cdmx: { name: 'CDMX', address: 'Rumania 613, Col. Portales, Benito Juárez', sourceId: 279 },
  atizapan: { name: 'Atizapán', address: 'Av. Río San Javier 29, Atizapán Centro', sourceId: 280 }
};
function absolute(value) {
  if (!value || !String(value).trim()) return '';
  try { const url = new URL(value, SOURCE_ORIGIN); return /^https?:$/.test(url.protocol) ? url.href : ''; }
  catch { return ''; }
}
function locationLinks(html) {
  const $ = cheerio.load(html);
  return [...new Set($('a[href]').map((_, el) => $(el).attr('href')).get().filter(v => /google\.[^/]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl/.test(v)))];
}
function getLocation(page, pages) {
  const links = locationLinks(page.sourceContent);
  if (!links.length) return null;
  const pageCity = cityOf(page.title + ' ' + page.slug);
  const mapped = links.map(url => ({ url: absolute(url), city: cityOf(decodeURIComponent(url)) }));
  if (!pageCity && new Set(mapped.map(m=>m.city).filter(Boolean)).size > 1) {
    return {multiple:true,city:null,name:'',address:'',url:'',phone:'',corrected:false,
      evidence:{sourceHadLocation:true,originalMaps:links,verifiedStorePage:page.id}};
  }
  const chosen = mapped.find(m => m.city === pageCity) || mapped[0];
  const city = pageCity || chosen.city;
  const store = STORES[city];
  let url = chosen.url, corrected = false;
  if (store && pageCity && chosen.city && chosen.city !== pageCity) {
    const verified = pages.find(p => p.id === store.sourceId);
    const replacement = locationLinks(verified.sourceContent).find(link => cityOf(decodeURIComponent(link)) === city);
    if (replacement) { url = absolute(replacement); corrected = true; }
  }
  const $ = cheerio.load(page.sourceContent);
  const phoneElement = $('a[href^="tel:"]').first();
  let phone = (phoneElement.attr('href') || '').replace(/\D/g, '') || text($, phoneElement).replace(/\D/g, '');
  if (corrected) {
    const other = cheerio.load(pages.find(p => p.id === store.sourceId).sourceContent);
    const a = other('a[href^="tel:"]').first();
    phone = (a.attr('href') || '').replace(/\D/g, '') || a.text().replace(/\D/g, '');
  }
  return { city, name: store?.name || '', address: store?.address || '', url, phone, corrected,
    evidence: { sourceHadLocation: true, originalMaps: links, verifiedStorePage: store?.sourceId || page.id } };
}
function sanitize(html, page, pages, location) {
  const $ = cheerio.load(html, {}, false);
  $('script,style,iframe,object,embed,form,input,button,select,textarea,link,meta,base,svg,math').remove();
  $('*').each((_, el) => {
    for (const attr of Object.keys(el.attribs || {})) {
      if (!['href','src','alt','title','width','height','colspan','rowspan'].includes(attr)) $(el).removeAttr(attr);
    }
  });
  $('a').each((_, el) => {
    const a = $(el), href = a.attr('href') || '';
    if (/^tel:/i.test(href)) {
      const number = href.replace(/\D/g, '') || a.text().replace(/\D/g, '');
      number ? a.attr('href', `tel:${number}`) : a.replaceWith(a.text());
      return;
    }
    if (/^mailto:/i.test(href)) return;
    if (href.startsWith('#')) { a.replaceWith(a.contents()); return; }
    const resolved = absolute(href);
    if (!resolved) { a.replaceWith(a.contents()); return; }
    const url = new URL(resolved);
    if (/(^|\.)mifiestashop\.com$/.test(url.hostname)) {
      const cms = url.pathname.match(/^\/content\/(\d+)-/);
      const product = url.pathname.match(/\/(\d+)-([^/]+\.html)$/);
      if (cms && pages.some(p => String(p.id) === cms[1])) a.attr('href', pages.find(p => String(p.id) === cms[1]).sourcePath);
      else if (product) a.attr('href', productLinks[`${product[1]}-${product[2]}`] || `/${product[1]}-${product[2]}`);
      else if (/^\/(2-productos|index\.php)?$/.test(url.pathname)) a.attr('href', '/?buscar=' + encodeURIComponent(THEMES[themeFor(page)].query));
      else if (/iniciar-sesion|mi-cuenta/.test(url.pathname)) a.attr('href', '/?cuenta=1');
      else a.attr('href', resolved);
    } else a.attr('href', resolved);
    a.attr('rel', 'noopener noreferrer');
  });
  $('img').each((_, el) => {
    const img = $(el), src = assetUrl(img.attr('src'), page);
    if (!src) { img.remove(); return; }
    img.attr('src', src).attr('loading','lazy').attr('decoding','async');
    if (!img.attr('alt')) img.attr('alt', page.title);
    img.removeAttr('width').removeAttr('height');
  });
  $('h1').each((_, el) => { el.tagName = 'h2'; el.name = 'h2'; });
  $('p,h2,h3,h4,a').each((_, el) => {
    const value = text($, el);
    if (/lorem ipsum|hotspot #|SIGUE BAJANDO/i.test(value)) $(el).remove();
  });
  if (location && !location.multiple) {
    $('a[href]').each((_, el) => {
      if (/maps|^tel:/.test($(el).attr('href'))) $(el).remove();
    });
    $('h2,h3,h4,p').each((_, el) => {
      if (/^(vis[ií]tanos|ver ubicaci[oó]n|tel\s*\d|\+?52\d{10})/i.test(text($,el))) $(el).remove();
    });
  }
  // Marketing copy sometimes refers to a different city because a CMS page was copied.
  // The requested title is authoritative; never modify quoted customer testimonials.
  const theme = themeFor(page);
  $('h2,h3,h4').each((_, el) => {
    const value = text($, el);
    if (theme !== 'xv' && /xv a[nñ]os/i.test(value)) $(el).text(page.title);
  });
  const pageCity = cityOf(page.title + ' ' + page.slug);
  if (pageCity && theme !== 'informacion') {
    const re = /Ciudad de M[eé]xico|CDMX|Quer[eé]taro|\bQRO\b|Puebla|Atizap[aá]n/gi;
    const replaceNodes = el => {
      for (const node of el.children || []) {
        if (node.type === 'text') node.data = node.data.replace(re, STORES[pageCity].name);
        else if (!['script','style'].includes(node.name)) replaceNodes(node);
      }
    };
    // Only marketing paragraphs before reviews. Keep customer quotations verbatim.
    let inReviews = false;
    $.root().contents().each((_, el) => {
      if (/opiniones|que dicen|reseñas/i.test(text($,el))) inReviews = true;
      if (!inReviews && !$(el).find('a[href*="maps"]').length) {
        if (el.type === 'text') el.data = el.data.replace(re, STORES[pageCity].name);
        else replaceNodes(el);
      }
    });
  }
  $('figure,p,h2,h3,h4,div,a').each((_, el) => { if (!text($,el) && !$(el).find('img').length) $(el).remove(); });
  // Flatten builder wrappers while retaining all semantic content and links.
  $('div,section,span').get().reverse().forEach(el => $(el).replaceWith($(el).contents()));
  $.root().contents().each((_, el) => {
    if (el.type === 'text' && el.data.trim()) $(el).replaceWith(`<p>${esc(el.data.trim())}</p>`);
  });
  return $.html();
}
function modelFor(page, pages) {
  const theme = themeFor(page), config = THEMES[theme];
  const $ = cheerio.load(page.sourceContent, {}, false);
  const location = getLocation(page, pages);
  const simple = /PAGA CON TARJETA/i.test($.text()) && /400 ARTICULOS/i.test(normalize($.text()).toUpperCase());
  const firstHeading = $('h1,h2').first();
  const images = $('img').map((_, el) => absolute($(el).attr('src'))).get().filter(Boolean);
  let image = '';
  if (firstHeading.length) image = firstHeading.nextAll().find('img').add(firstHeading.nextAll('img')).first().attr('src') || '';
  if (!image) image = images.find(src => /front-view|11927461|grupo1|BANNER-SOMBREROS/.test(src)) || '';
  if (theme === 'boda') image = 'https://iuoirslxjcyarvmrqyjd.supabase.co/storage/v1/object/public/assets/boda/articulos-para-batucada-en-mexico-articulos-para-fiesta-en-ciudad-de-mexico-ciudad-de-mexico-01-1.png';
  if (theme === 'globos') image = images.find(src=>/front-view/.test(src)) || image;
  if (theme === 'mayoreo') image = images.find(src=>/Birthday\.png/.test(src)) || image;
  if (/^(informacion|bicicletas|hogar|herramientas)$/.test(theme)) image = '';
  const benefits = [];
  $('h3').each((_, el) => {
    const title = text($, el);
    if (/paga con tarjeta|mayoreo desde|los mas originales/i.test(normalize(title))) {
      benefits.push({ title, content: text($, $(el).next('p')) });
    }
  });
  const reviews = [];
  {
    const sourceText = $.root().text().replace(/\s+/g,' ');
    for (const pattern of [/(Excelente lugar[\s\S]*?)(Alej[a-zá]+ Ch[aá]vez)/i, /(Un lugar muy completo[\s\S]*?)(Brenda Samperio)/i, /(Excelente atenci[oó]n[\s\S]*?)(Marina DRZ)/i, /(Encontr[eé] todo lo que buscaba[\s\S]*?)(Beto M[eé]ndez)/i, /(Necesitaba dos faldas[\s\S]*?)(Nereyda Ram[ií]rez)/i]) {
      const match = sourceText.match(pattern);
      if (match) reviews.push({quote:match[1].trim(),name:match[2]});
    }
  }
  let content = sanitize(page.sourceContent, page, pages, location);
  if (!simple && theme !== 'informacion') {
    const rich = cheerio.load(content, {}, false);
    // Reviews get the same readable cards as the reference page; don't duplicate them.
    const reviewHeading = rich('h2,h3').filter((_,el)=>/opiniones de nuestros clientes|que dicen de nosotros/i.test(normalize(text(rich,el)))).first();
    if (reviewHeading.length && reviews.length) {
      let node = reviewHeading[0].next;
      while(node) {
        const next=node.next;
        if(node.type==='tag' && /^h[23]$/.test(node.name) && /regalo|visitanos|hablemos/i.test(normalize(text(rich,node)))) break;
        rich(node).remove();node=next;
      }
      reviewHeading.remove();
    }
    rich('h2,h3,h4').each((_,el)=>{
      const value=normalize(text(rich,el));
      if(/paga con tarjeta|mayoreo desde|aqui tienes tu primer regalo/.test(value)) rich(el).remove();
      if(/envio gratis en compras mayores de \$1000/.test(value)) rich(el).text('Envío gratis en compras mayores a $1,500 MXN. Consulta condiciones.');
    });
    // Group original package lists and descriptions into readable editorial sections.
    const groups=[];let current=[];
    rich.root().contents().each((_,el)=>{
      if(el.type==='tag' && el.name==='h2' && current.length){groups.push(current.join(''));current=[];}
      current.push(rich.html(el));
    });
    if(current.length)groups.push(current.join(''));
    content=groups.filter(group=>{
      const block=cheerio.load(group,{},false);
      if (block.root().children().length===1 && block('h2').length) return false;
      return block.text().trim()||block('img').length;
    }).map(group=>`<section class="story-section">${group}</section>`).join('');
  }
  if (simple) {
    // Old builder pages consist of hero, benefits, catalog, reviews and location.
    // Recompose those blocks instead of carrying over its duplicate headlines/banners.
    content = '';
  }
  let description = page.description || config.intro;
  const pageCity = cityOf(page.title + ' ' + page.slug);
  if (pageCity && theme !== 'informacion') description = description.replace(/Ciudad de M[eé]xico|CDMX|Quer[eé]taro|\bQRO\b|Puebla|Atizap[aá]n/gi, STORES[pageCity].name);
  let heroImage = image ? assetUrl(image,page) : '';
  if (!heroImage && theme === 'fiesta') heroImage = '/img/hero-banner.png';
  if (!heroImage && theme === 'batucada') heroImage = '/img/cms/0dede4bf5e127bbe.jpg';
  if (!heroImage && theme === 'mayoreo') heroImage = '/img/cms/83d47782163fe737.png';
  return {...page, theme, config, location, heroImage, benefits, reviews, content,
    description, intro: config.intro || description, simple};
}
module.exports = { modelFor, sanitize, esc, cityOf, STORES, locationLinks };
