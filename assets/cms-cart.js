(()=>{'use strict';
 window.cmsAddToCart=async(product,button,status)=>{
 if(button.disabled)return;button.disabled=true;button.textContent='Agregando…';status.textContent='';
 try{
 const response=await fetch('/api/productos?limit=1000',{signal:AbortSignal.timeout(20000),cache:'no-store'});
 if(!response.ok)throw Error('catalog');const data=await response.json();const current=data.products?.find(p=>String(p.id)===String(product.id));
 if(!current||current.price===null||current.price===''||!Number.isFinite(Number(current.price))||Number(current.price)<=0)throw Error('unavailable');
 const cart=JSON.parse(localStorage.getItem('mf_cart')||'[]');if(!Array.isArray(cart))throw Error('cart');
 const existing=cart.find(p=>String(p.id)===String(current.id));
 const item={id:current.id,name:current.name||product.name,sku:current.sku||'PS-'+current.id,price:Number(current.price),cat:'general',img:product.img};
 if(existing){Object.assign(existing,item,{qty:(Number(existing.qty)||0)+1});}else cart.push({...item,qty:1});
 localStorage.setItem('mf_cart',JSON.stringify(cart));window.dispatchEvent(new Event('cms-cart-updated'));
 status.textContent='Agregado al carrito';button.textContent='Agregar otro';
 }catch{status.textContent='No pudimos agregarlo. Intenta de nuevo o consulta su ficha.';button.textContent='Agregar al carrito';}
 finally{button.disabled=false;}
 };
})();
