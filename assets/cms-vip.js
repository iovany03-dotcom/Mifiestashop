(() => {
  const form=document.getElementById('vip-form');if(!form)return;
  const phone=form.elements.phone,amount=form.elements.amount,email=form.elements.email;
  const wrap=document.getElementById('vip-email-wrap'),message=document.getElementById('vip-message'),button=form.querySelector('button');
  const threshold=Number(form.dataset.threshold);
  function updateEmail(){const needs=Number(amount.value)>0&&Number(amount.value)<threshold;wrap.hidden=!needs;email.required=needs;if(!needs)email.value='';}
  amount.addEventListener('input',updateEmail);updateEmail();
  form.addEventListener('submit',async event=>{
    event.preventDefault();let number=phone.value.replace(/\D/g,'');
    if(number.startsWith('521')&&number.length===13)number=number.slice(3);
    if(number.startsWith('52')&&number.length===12)number=number.slice(2);
    if(number.length!==10){message.textContent='Ingresa un teléfono de 10 dígitos.';phone.focus();return;}
    const value=Number(amount.value);if(!Number.isFinite(value)||value<=0){message.textContent='Ingresa un monto mayor a cero.';return;}
    if(!form.reportValidity())return;
    button.disabled=true;message.textContent='Enviando…';
    const url=new URL(form.dataset.endpoint);
    url.searchParams.set('phone',number);url.searchParams.set('amount',String(value));url.searchParams.set('email',value<threshold?email.value.trim():'');
    try{
      // Preserve the existing public Apps Script integration and city-specific destination.
      // Its opaque response cannot confirm delivery; don't display a false success message.
      await fetch(url.href,{method:'GET',mode:'no-cors',cache:'no-store'});
      window.location.assign(form.dataset.redirect);
    }catch{button.disabled=false;message.textContent='No pudimos enviar el registro. Intenta nuevamente.';}
  });
})();
