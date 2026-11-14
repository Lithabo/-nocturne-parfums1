const status = document.querySelector('#admin-status');
const storeForm = document.querySelector('#store');
const productForm = document.querySelector('#product');
const money = new Intl.NumberFormat('en-ZA',{style:'currency',currency:'ZAR'});
const format = cents => money.format(cents/100);
async function api(path,body) {
  const response = await fetch('/api/admin'+path,body ? {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
function paragraph(value) {
  const node = document.createElement('p');
  node.textContent = value;
  return node;
}
function action(label,work) {
  const button = document.createElement('button');
  button.className = 'add';
  button.textContent = label;
  button.addEventListener('click',async () => {
    button.disabled = true;
    try {
      await work();
    } catch (error) {
      status.textContent = error.message;
      status.scrollIntoView({block:'nearest'});
    } finally {
      button.disabled = false;
    }
  });
  return button;
}
function link(label,href) {
  const node = document.createElement('a');
  node.textContent = label;
  node.href = href;
  return node;
}
function rows(key,items,render) {
  const target = document.getElementById(key);
  target.replaceChildren();
  if (!items.length) target.append(paragraph('No records yet.'));
  for (const item of items) {
    const row = document.createElement('article');
    row.className = 'admin-record';
    render(row,item);
    target.append(row);
  }
}
function fill(form,values) {
  for (const [name,value] of Object.entries(values)) {
    const input = form.elements.namedItem(name);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value;
  }
  form.scrollIntoView({block:'start'});
}
function paymentLink(row,data) {
  const url = new URL(data.url);
  if (!['checkout.paystack.com','paystack.com','manage.paystack.com','dashboard.paystack.com'].includes(url.hostname) || url.protocol!=='https:')
    throw new Error('Unexpected Paystack link.');
  const node = document.createElement('input');
  node.value = url.href;
  node.readOnly = true;
  node.setAttribute('aria-label','Shareable Paystack link');
  node.addEventListener('focus',()=>node.select());
  row.append(node);
  node.focus();
}
async function refresh() {
  const data = await api('');
  rows('stores',data.stores,(row,s)=>{
    const date = s.access_until ? new Date(s.access_until).toLocaleDateString('en-ZA') : '—';
    row.append(paragraph(s.name+' · '+s.subscription_status+' · '+(s.enabled?'enabled':'paused')+' · Access through '+date));
    row.append(paragraph(s.email+' · '+s.whatsapp),link('View storefront','/?store='+encodeURIComponent(s.slug)));
    row.append(action('Edit store',()=>fill(storeForm,{...s,shipping:s.shipping_cents/100,payment_key:''})));
    if (s.subscription_status === 'pending') row.append(action('Get subscription link',async()=>paymentLink(row,await api('/billing',{slug:s.slug}))));
    if (s.subscription_code) row.append(action('Get Paystack management link',async()=>paymentLink(row,await api('/billing/manage',{slug:s.slug}))));
  });
  rows('products',data.products,(row,p)=>{
    row.append(paragraph(p.store_slug+' · '+p.name+' · '+p.sku+' · '+format(p.price_cents)+' · '+(p.active?'visible':'hidden')));
    row.append(action('Edit product',()=>fill(productForm,{...p,price:p.price_cents/100})));
  });
  rows('orders',data.orders,(row,o)=>{
    const c = o.customer;
    row.append(paragraph(o.ref+' · '+format(o.amount)+' · '+(o.shipped_at?'Shipped':'Paid')),
      paragraph(c.name+' · '+c.email+' · '+c.phone),paragraph([c.address,c.city,c.province,c.postcode].join(', ')),
      paragraph(o.items.map(item=>item.quantity+' × '+item.name).join(', ')));
    if (!o.shipped_at) row.append(action('Mark shipped',async()=>{await api('/ship',{ref:o.ref});await refresh();}));
  });
  rows('contacts',data.contacts,(row,c)=>{
    row.append(paragraph(c.store_slug+' · '+c.details.name+' · '+c.details.email),paragraph(c.details.message));
  });
  rows('notifications',data.notifications,(row,n)=>{
    row.append(paragraph(n.store_slug+' · '+n.kind+' · '+n.last_error+' · Attempts '+n.attempts));
    row.append(action('Retry',async()=>{await api('/retry',{id:n.id});await refresh();}));
  });
}
for (const [form,path] of [[storeForm,'/store'],[productForm,'/product']]) {
  form.addEventListener('submit',async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form));
      if (form===storeForm) {
        payload.shipping_cents = Math.round(Number(payload.shipping)*100);
        payload.enabled = form.elements.enabled.checked;
        if (!payload.payment_key) delete payload.payment_key;
      } else {
        payload.price_cents = Math.round(Number(payload.price)*100);
        payload.image_position = Number(payload.image_position);
        payload.active = form.elements.active.checked;
      }
      await api(path,payload);
      if (form===storeForm) form.elements.payment_key.value = '';
      status.textContent = 'Saved.';
      await refresh();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      status.scrollIntoView({block:'nearest'});
    }
  });
}
refresh().catch(error=>{status.textContent=error.message;});
