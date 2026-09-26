const test=require('node:test'),assert=require('node:assert/strict');
const handler=require('../api/ventas.js');
function call(query){const res={code:0,data:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.code=c;return this},json(d){this.data=d;return this}};return handler({query},res).then(()=>res);}
test('ventas devuelve el desglose por tienda y cuadra con el total',async()=>{
  const prev={fetch:global.fetch,base:process.env.PS_BASE_URL,key:process.env.PS_API_KEY};
  process.env.PS_BASE_URL='https://ps.test';process.env.PS_API_KEY='k';
  let requested='';
  global.fetch=async url=>{requested=String(url);return {ok:true,json:async()=>({orders:[
    {id:1,total_paid:'100.00',date_add:'2026-09-01 10:00:00',id_employee:'225'},
    {id:2,total_paid:'50.50',date_add:'2026-09-01 11:00:00',id_employee:'225'},
    {id:3,total_paid:'200.00',date_add:'2026-09-02 09:00:00',id_employee:'226'},
    {id:4,total_paid:'80.00',date_add:'2026-09-02 12:00:00',id_employee:'230'},
    {id:5,total_paid:'300.00',date_add:'2026-09-03 12:00:00',id_employee:'0'},
    {id:6,total_paid:'20.00',date_add:'2026-09-03 13:00:00'},
    {id:7,total_paid:'10.00',date_add:'2026-09-03 14:00:00',id_employee:'999'}
  ]})};};
  try{
    const r=await call({from:'2026-09-01',to:'2026-09-30'});
    assert.equal(r.code,200);assert.ok(requested.includes('id_employee'));
    const by=Object.fromEntries(r.data.byStore.map(s=>[s.store,s]));
    assert.deepEqual([by['CDMX Rumania'].revenue,by['CDMX Rumania'].orders,by['CDMX Rumania'].avgTicket],[150.5,2,75.25]);
    assert.deepEqual([by['Querétaro'].revenue,by['Querétaro'].orders],[200,1]);
    assert.deepEqual([by['Puebla'].revenue,by['Puebla'].orders],[80,1]);
    assert.deepEqual([by['Tienda en línea'].revenue,by['Tienda en línea'].orders],[320,2]);
    assert.deepEqual([by['Otros'].revenue,by['Otros'].orders],[10,1]);
    assert.deepEqual([by['Atizapán'].revenue,by['Atizapán'].orders,by['Atizapán'].avgTicket,by['Atizapán'].share],[0,0,0,0]);
    assert.equal(Math.round(r.data.byStore.reduce((s,x)=>s+x.revenue,0)*100)/100,r.data.revenue);
    assert.equal(r.data.byStore.reduce((s,x)=>s+x.orders,0),r.data.orders);
    const sorted=[...r.data.byStore].sort((a,b)=>b.revenue-a.revenue).map(s=>s.store);assert.deepEqual(r.data.byStore.map(s=>s.store),sorted);
    assert.equal(by['Tienda en línea'].share,Math.round(320/760.5*1000)/10);
  }finally{global.fetch=prev.fetch;process.env.PS_BASE_URL=prev.base;process.env.PS_API_KEY=prev.key;if(prev.base===undefined)delete process.env.PS_BASE_URL;if(prev.key===undefined)delete process.env.PS_API_KEY;}
});
test('ventas sin pedidos deja todas las tiendas en cero y sin "Otros"',async()=>{
  const prev={fetch:global.fetch,base:process.env.PS_BASE_URL,key:process.env.PS_API_KEY};
  process.env.PS_BASE_URL='https://ps.test';process.env.PS_API_KEY='k';
  global.fetch=async()=>({ok:true,json:async()=>({orders:[]})});
  try{
    const r=await call({from:'2026-09-01',to:'2026-09-30'});
    assert.equal(r.code,200);assert.equal(r.data.byStore.length,5);assert.ok(r.data.byStore.every(s=>s.revenue===0&&s.orders===0&&s.share===0));
    assert.ok(!r.data.byStore.some(s=>s.store==='Otros'));
  }finally{global.fetch=prev.fetch;process.env.PS_BASE_URL=prev.base;process.env.PS_API_KEY=prev.key;if(prev.base===undefined)delete process.env.PS_BASE_URL;if(prev.key===undefined)delete process.env.PS_API_KEY;}
});
