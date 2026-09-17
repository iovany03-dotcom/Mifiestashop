// Vercel serverless function: fetches products directly from PrestaShop API
//
// Requires env vars:
//   PS_BASE_URL   e.g. https://www.mifiestashop.com
//   PS_API_KEY    the PrestaShop webservice key
//
// Migración a nuestro propio sistema: para los productos que ya tienen un
// registro en productos_migrados (Supabase) — nombre, descripción, SKU,
// categoría e imágenes, todo real, con las imágenes ya re-hospedadas en
// Supabase Storage — se usan esos datos en vez de los de PrestaShop.
// Precio y stock siguen viniendo siempre en vivo de PrestaShop (decisión
// explícita: solo se migró lo descriptivo, no el inventario).
const SUPABASE_URL = 'https://iuoirslxjcyarvmrqyjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1b2lyc2x4amN5YXJ2bXJxeWpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTg3OTUsImV4cCI6MjEwNDY3NDc5NX0.xX4w3DbmPuTenwpZcotLRH_O3YAdRrBdz4gTWviJs5k';

async function fetchMigratedProducts() {
  // PostgREST limita a 1000 filas por default — con más de 1000 productos
  // migrados hay que paginar con el header Range, si no se pierden
  // silenciosamente los últimos (ya pasó: 1067 migrados, solo llegaban 1000).
  const PAGE_SIZE = 1000;
  const map = {};
  try {
    let from = 0;
    while (true) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/productos_migrados?select=id,sku,name,description,category_label,category_ids,images`, {
        headers: {
          apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Range: `${from}-${from + PAGE_SIZE - 1}`
        }
      });
      if (!r.ok) break;
      const rows = await r.json();
      const batch = Array.isArray(rows) ? rows : [];
      batch.forEach(row => { map[String(row.id)] = row; });
      if (batch.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  } catch (e) {
    // se queda con lo que ya haya juntado hasta el momento del error
  }
  return map;
}

// Precios de mayoreo reales de PrestaShop (recurso "specific_prices"): para
// el grupo de clientes "Cliente" (id 60 en esta tienda) hay una regla por
// producto con un umbral de piezas ("from_quantity", varía por producto —
// no siempre son 3) y una reducción sobre el precio base. Se usa la regla
// con el umbral más bajo como "el" precio de mayoreo del producto — el
// mismo concepto que el campo editable priceMayoreo del admin, pero real
// en vez de vacío por default.
const WHOLESALE_GROUP_ID = '60';

async function fetchWholesalePrices(baseUrl, headers) {
  try {
    const fields = '[id,id_product,id_group,from_quantity,reduction,reduction_type,price]';
    const url = `${baseUrl}/api/specific_prices?filter[id_group]=${WHOLESALE_GROUP_ID}&display=${encodeURIComponent(fields)}&limit=0,5000&output_format=JSON`;
    const r = await fetch(url, { headers });
    if (!r.ok) return {};
    const data = await r.json();
    const rows = Array.isArray(data.specific_prices) ? data.specific_prices : [];
    const byProduct = {};
    rows.forEach(row => {
      const pid = String(row.id_product);
      const fromQty = parseInt(row.from_quantity, 10) || 1;
      if (!byProduct[pid] || fromQty < byProduct[pid].fromQty) {
        byProduct[pid] = { fromQty, reduction: parseFloat(row.reduction || 0), reductionType: row.reduction_type, price: parseFloat(row.price) };
      }
    });
    return byProduct;
  } catch (e) {
    return {};
  }
}

function computeWholesalePrice(basePrice, rule) {
  if (!rule) return null;
  if (Number.isFinite(rule.price) && rule.price >= 0) return { price: rule.price, fromQty: rule.fromQty };
  if (rule.reductionType === 'percentage') return { price: basePrice * (1 - rule.reduction), fromQty: rule.fromQty };
  return { price: Math.max(0, basePrice - rule.reduction), fromQty: rule.fromQty };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const baseUrl = process.env.PS_BASE_URL || 'https://www.mifiestashop.com';
  const apiKey = process.env.PS_API_KEY;

  if (!apiKey) {
    // If PS_API_KEY is not set in env, return fallback message or status
    res.status(400).json({ 
      error: 'Falta variable de entorno PS_API_KEY en Vercel',
      message: 'Configure PS_API_KEY en Vercel para sincronizar los productos de PrestaShop en vivo.'
    });
    return;
  }

  const limit = parseInt(req.query.limit, 10) || 500;
  const offset = parseInt(req.query.offset, 10) || 0;
  const category = req.query.category;
  const SORT_MAP = { price_asc: '[price_ASC]', price_desc: '[price_DESC]', name_asc: '[name_ASC]', name_desc: '[name_DESC]' };
  const sort = SORT_MAP[req.query.sort];
  const fields = '[id,name,reference,price,id_default_image,id_category_default,active,description_short,description,link_rewrite,wholesale_price,ean13,weight,width,height,depth,meta_title,meta_description,meta_keywords,low_stock_threshold]';
  let filters = 'filter[active]=1';
  if (category) filters += `&filter[id_category_default]=${encodeURIComponent('[' + category + ']')}`;
  if (sort) filters += `&sort=${sort}`;
  const productsUrl = `${baseUrl}/api/products?display=${encodeURIComponent(fields)}&${filters}&limit=${offset},${limit}&output_format=JSON`;

  // Extrae el primer valor de un campo multi-idioma de PrestaShop (array u objeto),
  // garantizando que el resultado sea siempre un string usable (PrestaShop a veces
  // devuelve `false` en vez de '' cuando el campo está vacío en algún idioma).
  function firstLangValue(field, fallback) {
    let val = field;
    if (Array.isArray(field)) {
      val = field[0]?.value;
      if (val === undefined) val = field[0];
    } else if (field && typeof field === 'object') {
      val = field.value !== undefined ? field.value : Object.values(field)[0];
    }
    if (typeof val !== 'string' || val === '') return fallback;
    return val;
  }

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const r = await fetch(productsUrl, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) {
      const text = await r.text();
      res.status(502).json({ error: `PrestaShop API error ${r.status}`, detail: text.slice(0, 500) });
      return;
    }

    const data = await r.json();
    const rawProducts = Array.isArray(data.products) ? data.products : [];
    const [migrated, wholesaleRules] = await Promise.all([
      fetchMigratedProducts(),
      fetchWholesalePrices(baseUrl, { Authorization: `Basic ${auth}` })
    ]);

    const products = rawProducts.map(p => {
      const nameStr = firstLangValue(p.name, 'Producto PrestaShop');
      // La descripción corta no siempre está llena en PrestaShop; si falta,
      // se usa la descripción larga del producto como respaldo.
      const shortDesc = firstLangValue(p.description_short, '').replace(/<[^>]*>/g, '').trim();
      const longDesc = firstLangValue(p.description, '').replace(/<[^>]*>/g, '').trim();
      const descStr = shortDesc || longDesc;
      const linkRewrite = firstLangValue(p.link_rewrite, '');

      const imgId = p.id_default_image;
      let imageUrl = 'https://images.unsplash.com/photo-1530103862676-de8c9debad1d?w=300';
      if (imgId && imgId !== '0') {
        imageUrl = `${baseUrl}/api/images/products/${p.id}/${imgId}?ws_key=${apiKey}`;
      }

      // Liga real y pública del producto en la tienda en vivo (mifiestashop.com).
      const publicUrl = linkRewrite ? `${baseUrl}/${p.id}-${linkRewrite}.html` : `${baseUrl}/index.php?id_product=${p.id}&controller=product`;

      const m = migrated[String(p.id)];
      const images = m && Array.isArray(m.images) && m.images.length > 0 ? m.images : null;
      const basePrice = parseFloat(p.price || 0);
      const wholesale = computeWholesalePrice(basePrice, wholesaleRules[String(p.id)]);

      // costoCompra: PrestaShop llama a este campo "wholesale_price" en su
      // propio esquema, pero es el costo real que le cuesta a la tienda
      // (lo que en nuestro admin es "Precio compra"), no un precio de
      // mayoreo al cliente — eso ya se resuelve arriba con specific_prices.
      const costoCompra = parseFloat(p.wholesale_price || 0) || undefined;
      const metaTitle = firstLangValue(p.meta_title, '');
      const metaDescription = firstLangValue(p.meta_description, '');
      // Muchos productos tienen el literal "Meta keywords-" tecleado dentro
      // del propio valor (un error de captura en PrestaShop) — se quita para
      // no mostrar eso tal cual en el <meta name="keywords"> real.
      const metaKeywords = firstLangValue(p.meta_keywords, '').replace(/^meta\s*keywords[\s-]*/i, '').trim();
      const weight = parseFloat(p.weight || 0) || undefined;
      const width = parseFloat(p.width || 0) || undefined;
      const height = parseFloat(p.height || 0) || undefined;
      const depth = parseFloat(p.depth || 0) || undefined;

      return {
        id: p.id,
        name: m ? m.name : nameStr,
        description: m && m.description ? m.description : descStr,
        sku: m ? m.sku : (p.reference || `PS-${p.id}`),
        barcode: p.ean13 || undefined,
        price: basePrice,
        priceMayoreo: wholesale ? Math.round(wholesale.price * 100) / 100 : undefined,
        priceMayoreoDesdeUnidades: wholesale ? wholesale.fromQty : undefined,
        costoCompra,
        categoryId: p.id_category_default || '1',
        categoryLabel: m ? m.category_label : undefined,
        categoryIds: m && Array.isArray(m.category_ids) && m.category_ids.length > 0 ? m.category_ids : undefined,
        weight, width, height, depth,
        metaTitle: metaTitle || undefined,
        metaDescription: metaDescription || undefined,
        metaKeywords: metaKeywords || undefined,
        lowStockThreshold: parseInt(p.low_stock_threshold, 10) || undefined,
        img: images ? images[0] : imageUrl,
        images: images || undefined,
        migrated: !!m,
        linkRewrite,
        url: publicUrl
      };
    });

    res.status(200).json({
      count: products.length,
      products
    });
  } catch (err) {
    res.status(500).json({ error: 'Fallo al consultar API de Productos PrestaShop', detail: String(err) });
  }
};
