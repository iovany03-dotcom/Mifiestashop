const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAddress, addressesByCustomer, enrichCustomer } = require('../lib/customer-addresses');
const { runFullSync } = require('../lib/sync-prestashop');
const { wholesale } = require('../lib/native-catalog');
const store = require('../lib/migration-store');
const json = (value, status=200) => new Response(JSON.stringify(value), {status,headers:{'Content-Type':'application/json'}});
const response = () => ({ code:0, data:null, headers:{}, setHeader(k,v){this.headers[k]=v},status(n){this.code=n;return this},json(v){this.data=v;return this},send(v){this.data=v;return this} });
const ctx = {baseUrl:'https://source.test',apiKey:'test',supabaseUrl:'https://db.test',serviceKey:'test',timeBudgetMs:60000};

test('imported inventory history requires authentication before querying documents', async t => {
  t.mock.method(store, 'request', async () => { throw new Error('Must not read private documents'); });
  const res = response();
  await require('../api/inventory-history')({method:'POST',body:{}}, res);
  assert.equal(res.code,401);
  assert.equal(res.headers['Cache-Control'],'no-store');
});

test('historical movements use an exclusive cursor and never write stock', async t => {
  t.mock.method(store,'requireSession',async()=>true);
  const queries=[];
  t.mock.method(store,'request',async(path,options)=>{
    assert.equal(options,undefined);queries.push(path);
    return Array.from({length:51},(_,i)=>({id:299-i,data:{id_stock:86719,sign:-1,physical_quantity:2}}));
  });
  const res=response();
  await require('../api/inventory-history')({query:{kind:'movements',before:'300'}},res);
  assert.equal(res.data.movements.length,50);
  assert.equal(res.data.nextBefore,250);assert.equal(res.data.hasMore,true);
  assert.ok(queries[0].endsWith('&id=lt.300'));
  const invalid=response();
  await require('../api/inventory-history')({query:{kind:'movements',before:'300&select=*'}},invalid);
  assert.equal(invalid.code,400);assert.equal(queries.length,1);
});

test('inventory history paginates summaries and reads detail without applying stock', async t => {
  t.mock.method(store, 'requireSession', async () => true);
  const queries = [];
  t.mock.method(store, 'request', async (path, options) => {
    assert.equal(options,undefined);
    queries.push(path);
    if (path.includes('id=eq.72')) return [{data:{id:72,lines:[],history:[['original event']]}}];
    return Array.from({length:51}, (_,i) => ({id:100-i,data:{document:'ENT-'+i,lines:[{}],history:[]}}));
  });
  const handler = require('../api/inventory-history');
  const page = response();
  await handler({method:'POST',query:{offset:'50'}},page);
  assert.equal(page.data.documents.length,50);
  assert.equal(page.data.nextOffset,100);
  assert.equal(page.data.hasMore,true);
  assert.ok(queries[0].includes('order=id.desc&offset=50&limit=51'));
  const detail = response();
  await handler({method:'POST',query:{id:'72'}},detail);
  assert.deepEqual(detail.data.document.lines,[]);
  assert.deepEqual(detail.data.document.history,[['original event']]);
  const invalid = response();
  await handler({method:'POST',query:{id:'72&select=*'}},invalid);
  assert.equal(invalid.code,400);
  assert.equal(queries.length,2);
});

test('multiple addresses retain both fiscal fields, mobile phone and inactive history',()=>{
  const rows = [
    {id:1,id_customer:4,address1:'Vieja',phone:'111',dni:'RFC1',vat_number:'VAT1',active:1,date_upd:'2025-01-01'},
    {id:2,id_customer:4,address1:'Nueva',address2:'Interior',phone_mobile:'222',active:1,date_upd:'2026-01-01'},
    {id:3,id_customer:4,address1:'Borrada',deleted:1,active:1},
    {id:4,id_customer:4,address1:'Inactiva',active:0}
  ].map(normalizeAddress);
  assert.equal(rows[0].vat_number,'VAT1');
  const grouped=addressesByCustomer(rows);
  assert.equal(grouped.get('4').length,2);
  const customer=enrichCustomer({id:4},grouped.get('4'));
  assert.equal(customer.address,'Nueva, Interior'); assert.equal(customer.phone,'222'); assert.equal(customer.rfc,'RFC1');
  assert.equal(customer.addresses.length,2);
  assert.equal(enrichCustomer({id:5,phone:'existing'}).phone,'existing');
});

test('address import resumes only after a durable page and reconciles at end',async t=>{
  const saved=[],states=[],deleted=[];let calls=0;
  t.mock.method(global,'fetch',async(url,opts={})=>{
    if(url.includes('/ps_clientes?')) return json([{id:5}]);
    if(url.includes('/api/addresses')) {
      calls++;
      const filter=new URL(url).searchParams.get('filter[id]');
      assert.equal(new URL(url).searchParams.get('filter[id_customer]'),'[5,5]');
      if(calls===1){assert.equal(filter,'[251,999999999]');return json({addresses:[{id:251,id_customer:5,address1:'A',active:1},{id:252,id_customer:999,address1:'Other shop'}]});}
      assert.equal(filter,'[253,999999999]');return json({addresses:[]});
    }
    if(url.includes('ps_sync_estado')&&!opts.method)return json([{last_synced_id:250,ultimo_resultado:'cycle:previous-cycle'}]);
    if(url.includes('ps_sync_estado')){states.push(JSON.parse(opts.body));return new Response(null,{status:204});}
    if(opts.method==='DELETE'){deleted.push(url);return new Response(null,{status:204});}
    saved.push(...JSON.parse(opts.body));return new Response(null,{status:204});
  });
  const result=await runFullSync({...ctx,domains:['direcciones']});
  assert.equal(result.direcciones.complete,true);assert.equal(saved[0].id,251);
  assert.equal(saved.length,1);
  assert.equal(saved[0].generation,'previous-cycle');assert.equal(deleted.length,1);
  assert.equal(states.at(-1).last_synced_id,0);
});

test('denied source permission and failed upsert never mark a migration complete or delete data',async t=>{
  for(const failAt of ['source','write']) {
    const writes=[];
    t.mock.method(global,'fetch',async(url,opts={})=>{
      if(url.includes('/ps_clientes?')) return json([{id:2}]);
      if(url.includes('/api/addresses'))return failAt==='source'?json({},403):json({addresses:[{id:1,id_customer:2,active:1}]});
      if(url.includes('ps_sync_estado')&&!opts.method)return json([]);
      if(opts.method==='DELETE')throw new Error('Unexpected deletion');
      if(url.includes('ps_direcciones'))return json({},500);
      writes.push(JSON.parse(opts.body));return new Response(null,{status:204});
    });
    const result=await runFullSync({...ctx,domains:['direcciones']});
    assert.equal(result.direcciones.ok,false);
    assert.ok(writes.every(row=>row.last_synced_id===0 && row.ultimo_resultado.startsWith('cycle:')));
    t.mock.restoreAll();
  }
});

test('unknown resource shape cannot delete existing snapshots',async t=>{
  let deleted=false;
  t.mock.method(global,'fetch',async(url,opts={})=>{
    if(opts.method==='DELETE'){deleted=true;return new Response(null,{status:204});}
    if(url.includes('/api/'))return json({error:'bad schema'});
    return opts.method?new Response(null,{status:204}):json([]);
  });
  const result=await runFullSync({...ctx,domains:['precios']});
  assert.equal(result.precios.ok,false);assert.equal(deleted,false);
});

test('customer replay does not null out existing address columns',async t=>{
  let payload;
  t.mock.method(global,'fetch',async(url,opts={})=>{
    if(url.includes('/api/customers'))return json({customers:[{id:1,firstname:'A',active:1}]});
    if(url.includes('ps_clientes')){payload=JSON.parse(opts.body)[0];return new Response(null,{status:204});}
    return opts.method?new Response(null,{status:204}):json([]);
  });
  await runFullSync({...ctx,domains:['clientes']});
  for(const field of ['phone','rfc','address','postcode','city'])assert.equal(Object.hasOwn(payload,field),false);
});

test('private customer endpoint rejects anonymous requests before reading personal data',async t=>{
  t.mock.method(store,'all',async()=>{throw new Error('Personal data must not be queried')});
  const res=response();
  await require('../lib/native-customers')({method:'POST',body:{}},res);
  assert.equal(res.code,401);assert.equal(res.headers['Cache-Control'],'no-store');
});

test('wholesale discount follows explicit price and excludes expired or customer-specific rules',()=>{
  const rule={id:1,id_product:10,id_group:60,from_quantity:3,price:'80',reduction:'0.1',reduction_type:'percentage'};
  assert.deepEqual(wholesale(100,[rule],10),{price:72,fromQty:3});
  assert.deepEqual(wholesale(100,[{...rule,id_shop:50}],10),{price:72,fromQty:3});
  assert.equal(wholesale(100,[{...rule,id_shop:1}],10),null);
  assert.equal(wholesale(100,[{...rule,id_customer:7}],10),null);
  assert.equal(wholesale(100,[{...rule,to:'2020-01-01 00:00:00'}],10),null);
  assert.equal(wholesale(100,[{...rule,reduction_type:'amount',reduction_tax:1}],10),null);
});

test('authenticated customer directory bounds responses and only reads page addresses',async t=>{
  t.mock.method(store,'requireSession',async()=>true);
  t.mock.method(store,'request',async path=>{
    assert.match(path,/offset=250&limit=251/);
    return Array.from({length:251},(_,i)=>({id:1000+i,name:'Cliente'}));
  });
  t.mock.method(store,'all',async(table,query)=>{
    assert.equal(table,'ps_direcciones');
    assert.match(query,/id_customer=in\.\(1000,1001,/);
    assert.doesNotMatch(query,/1250/);
    return [{id:1,id_customer:1000,address1:'A',phone:'123',active:true}];
  });
  const res=response();
  await require('../lib/native-customers')({method:'POST',body:{},query:{offset:'250'}},res);
  assert.equal(res.code,200);assert.equal(res.data.customers.length,250);
  assert.equal(res.data.hasMore,true);assert.equal(res.data.nextOffset,500);
  assert.equal(res.data.customers[0].phone,'123');
});

test('promotion packages use migrated descriptions and local links without source credentials',async t=>{
  const previous=process.env.PS_NATIVE_COMMERCE;
  process.env.PS_NATIVE_COMMERCE='1';
  t.after(()=>{if(previous===undefined)delete process.env.PS_NATIVE_COMMERCE;else process.env.PS_NATIVE_COMMERCE=previous;});
  t.mock.method(global,'fetch',async()=>{throw new Error('Source network forbidden')});
  t.mock.method(store,'all',async table=>table==='productos_migrados'
    ?[{id:10,images:['/img/local.webp']}]
    :[{id:10,data:{id:10,active:1,price:'100',name:'Paquete',link_rewrite:'paquete',description:'<ul><li>Uno</li><li>Dos</li></ul>'}}]);
  const res=response();await require('../api/promo-paquetes')({query:{ids:'10'}},res);
  assert.equal(res.code,200);assert.equal(res.data.packages[0].price,100);
  assert.deepEqual(res.data.packages[0].items,['Uno','Dos']);
  assert.equal(res.data.packages[0].url,'/10-paquete.html');
  assert.equal(res.data.packages[0].img,'/img/local.webp');
  assert.doesNotMatch(JSON.stringify(res.data),/ws_key|mifiestashop\.com/);
});

test('checkout uses local authoritative prices and combines duplicated lines for stock validation',async t=>{
  t.mock.method(store,'all',async table=>table==='ps_productos_comercio'
    ?[{id:1,data:{id:1,active:1,price:'25.55',name:'Artículo'}}]
    :[{data:{id_product:1,id_product_attribute:0,id_shop:50,quantity:3}},{data:{id_product:1,id_product_attribute:0,id_shop:1,quantity:999}}]);
  const {resolveItems}=require('../lib/native-checkout');
  const valid=await resolveItems([{id:1,qty:1},{id:1,qty:2}]);
  assert.equal(valid.length,1);assert.equal(valid[0].qty,3);assert.equal(valid[0].price,25.55);
  assert.deepEqual(await resolveItems([{id:1,qty:2},{id:1,qty:2}]),[null]);
});

test('Supabase pagination returns 1067 products and propagates a later page failure',async t=>{
  process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';
  t.after(()=>delete process.env.SUPABASE_SERVICE_ROLE_KEY);
  t.mock.method(global,'fetch',async(url,opts)=>json(Array.from({length:opts.headers.Range==='0-999'?1000:67},(_,i)=>({id:i}))));
  assert.equal((await store.all('productos_migrados')).length,1067);
  t.mock.restoreAll();
  t.mock.method(global,'fetch',async(url,opts)=>opts.headers.Range==='0-999'?json(Array.from({length:1000},()=>({id:1}))):json({},500));
  await assert.rejects(store.all('productos_migrados'),/HTTP 500/);
});

test('sitemap includes the last 67 products and fails closed on a missing page',async t=>{
  const before=process.env.PS_API_KEY;process.env.PS_API_KEY='test';
  t.after(()=>{if(before===undefined)delete process.env.PS_API_KEY;else process.env.PS_API_KEY=before});
  t.mock.method(global,'fetch',async url=>{
    const offset=Number(new URL(url).searchParams.get('limit').split(',')[0]);
    return json({products:Array.from({length:Math.min(500,1067-offset)},(_,i)=>({id:offset+i+1,link_rewrite:'articulo'}))});
  });
  const res=response();await require('../api/sitemap')({query:{}},res);
  assert.equal(res.code,200);assert.match(res.data,/1067-articulo.html/);
  assert.equal((res.data.match(/<priority>0.8<\/priority>/g)||[]).length,1067);
  t.mock.restoreAll();t.mock.method(global,'fetch',async()=>json({},502));
  const failed=response();await require('../api/sitemap')({query:{}},failed);
  assert.equal(failed.code,503);
});

test('checkout never confirms an order whose database insert failed',async t=>{
  process.env.PS_NATIVE_COMMERCE='1';t.after(()=>delete process.env.PS_NATIVE_COMMERCE);
  t.mock.method(require('../lib/native-checkout'),'resolveItems',async()=>[{id:1,qty:1,name:'A',price:10,sku:'a'}]);
  t.mock.method(global,'fetch',async()=>json({},500));
  const res=response();
  await require('../api/crear-pedido')({method:'POST',body:{items:[{id:1,qty:1}],customer_name:'A',customer_email:'a@example.com',customer_phone:'1',address:'A',colonia:'A',municipio:'A',estado:'A',cp:'01000',shipping_cost:0}},res);
  assert.equal(res.code,503);assert.equal(res.data.folio,undefined);
});

test('historical import starts at the oldest ID, includes IDs beyond 3000 and resumes after writes',async t=>{
  const stored=[],cursors=[];let page=0;
  t.mock.method(global,'fetch',async(url,opts={})=>{
    if(url.includes('/api/orders?')) {
      assert.match(url,/sort=\[id_ASC\]/);assert.match(url,/limit=0,100/);
      page++;
      return json({orders:page===1?[{id:1,id_customer:1},{id:4001,id_customer:1}]:[]});
    }
    if(url.includes('/api/shops'))return json({shops:[]});
    if(url.includes('/api/order_states'))return json({order_states:[]});
    if(url.includes('/api/customers'))return json({customers:[{id:1,firstname:'A'}]});
    if(url.includes('/api/order_details'))return json({order_details:[{id_order:1,product_id:1,product_quantity:2,product_price:10}]});
    if(url.includes('ps_pedidos')){stored.push(...JSON.parse(opts.body));return new Response(null,{status:204});}
    if(url.includes('ps_sync_estado')&&opts.method){cursors.push(JSON.parse(opts.body));return new Response(null,{status:204});}
    return json([]);
  });
  const result=await runFullSync({...ctx,domains:['pedidos_historicos']});
  assert.equal(result.pedidos_historicos.complete,true);
  assert.deepEqual(stored.map(row=>row.id),[1,4001]);
  assert.equal(stored[0].items[0].qty,2);
  assert.equal(cursors.at(-1).last_synced_id,4001);
});
