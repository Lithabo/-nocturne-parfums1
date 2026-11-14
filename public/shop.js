const params = new URLSearchParams(location.search);
const slug = params.get('store') || 'nocturne';
const storeApi = '/api/store/'+encodeURIComponent(slug);
const money = new Intl.NumberFormat('en-ZA',{style:'currency',currency:'ZAR'});
const format = cents => money.format(cents/100);
const drawer = document.querySelector('#drawer');
const content = document.querySelector('#drawer-content');
const grid = document.querySelector('#products');
let products = [];
let shipping = 0;
let quantities = {};
const bagKey = 'nocturne-bag:'+slug;
const text = value => String(value).replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
try {
  const saved = JSON.parse(localStorage.getItem(bagKey));
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) quantities = saved;
} catch {}
const qty = item => {
  const n = quantities[item.sku];
  return Number.isInteger(n) && n>=0 && n<=20 ? n : 0;
};
function saveBag() {
  try { localStorage.setItem(bagKey,JSON.stringify(quantities)); } catch {}
  document.querySelector('#count').textContent = products.reduce((sum,item) => sum+qty(item),0);
}

for (const link of document.querySelectorAll('#contact-link,#contact-section-link')) link.search = '?store='+encodeURIComponent(slug);
const status = document.querySelector('#payment-status');
async function checkPayment() {
  const ref = params.get('payment');
  if (!ref) return;
  status.hidden = false;
  status.textContent = 'Payment is awaiting confirmation. If you were charged, contact the store before paying again.';
  if (ref === 'pending') return;
  try {
    const response = await fetch(storeApi+'/payment/'+encodeURIComponent(ref));
    if (!response.ok || !(await response.json()).paid) return;
    quantities = {};
    saveBag();
    status.textContent = 'Payment confirmed. Thank you for your order. Reference: '+ref;
    params.delete('payment');
    history.replaceState(null,'',location.pathname+(params.size?'?'+params:''));
  } catch {}
}
void checkPayment();
function showBag() {
  const items = products.filter(qty);
  const subtotal = items.reduce((sum,item) => sum+item.price_cents*qty(item),0);
  content.innerHTML = '<h2 id="dialog-title">Your bag</h2>' + (items.length ? items.map(item =>
    `<div class="line"><span>${text(item.name)}<br>${format(item.price_cents)}</span><div>
    <button class="qty" data-sku="${item.sku}" data-change="-1" aria-label="Remove one ${text(item.name)}">−</button> ${qty(item)}
    <button class="qty" data-sku="${item.sku}" data-change="1" aria-label="Add one ${text(item.name)}">+</button></div></div>`
  ).join('') + `<p>Subtotal ${format(subtotal)} · Delivery ${format(shipping)}</p>
  <p><strong>Total ${format(subtotal+shipping)}</strong></p><button class="add" id="checkout">Checkout</button>` : '<p>Your bag is empty.</p>');
  if (!drawer.open) drawer.showModal();
}
function showCheckout() {
  content.innerHTML = `<h2 id="dialog-title">Delivery details</h2><form class="fields" id="checkout-form">
  <label>Name<input name="name" required maxlength="120" autocomplete="name"></label>
  <label>Email<input name="email" type="email" required autocomplete="email"></label>
  <label>Phone<input name="phone" type="tel" required autocomplete="tel"></label>
  <label>Street address<input name="address" required autocomplete="street-address"></label>
  <label>City<input name="city" required autocomplete="address-level2"></label>
  <label>Province<select name="province" required>${['KwaZulu-Natal','Gauteng','Western Cape','Eastern Cape','Free State','Limpopo','Mpumalanga','North West','Northern Cape'].map(x=>'<option>'+x+'</option>').join('')}</select></label>
  <label>Postcode<input name="postcode" required pattern="[0-9]{4}" inputmode="numeric" autocomplete="postal-code"></label>
  <button class="add">Continue to secure card payment</button><p role="status"></p></form>`;
  const form = content.querySelector('form');
  form.addEventListener('submit',async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form));
      payload.items = products.filter(qty).map(item => ({sku:item.sku,quantity:qty(item)}));
      const result = await fetch(storeApi+'/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const data = await result.json();
      if (!result.ok) throw new Error(data.error);
      const url = new URL(data.url);
      if (url.origin !== 'https://checkout.paystack.com') throw new Error('Unexpected payment link.');
      location.assign(url.href);
    } catch (error) {
      form.querySelector('[role=status]').textContent = error.message || 'Could not open checkout.';
      button.disabled = false;
    }
  });
  form.querySelector('input').focus();
}
function showProduct(item) {
  content.innerHTML = `<h2 id="dialog-title">${text(item.name)}</h2><p>${text(item.notes)}</p>
    <p>${text(item.size)} · ${format(item.price_cents)}</p><button class="add" data-sku="${item.sku}" data-change="1">Add to bag</button>`;
  if (!drawer.open) drawer.showModal();
}
document.addEventListener('click',event => {
  const button = event.target.closest('button');
  if (!button) return;
  const item = products.find(product => product.sku===button.dataset.sku);
  if (item && button.hasAttribute('data-product')) showProduct(item);
  if (item && button.dataset.change) {
    quantities[item.sku] = Math.min(20,Math.max(0,qty(item)+Number(button.dataset.change)));
    saveBag();
    showBag();
    (content.querySelector(`[data-sku="${item.sku}"][data-change="${button.dataset.change}"]`) || document.querySelector('#close')).focus();
  }
  if (button.id==='bag') showBag();
  if (button.id==='close') drawer.close();
  if (button.id==='checkout') showCheckout();
});

async function loadCatalogue() {
  try {
    const response = await fetch(storeApi);
    if (!response.ok) throw new Error();
    const data = await response.json();
    products = data.products;
    shipping = data.store.shipping_cents;
    if (slug!=='nocturne') {
      document.title = data.store.name;
      for (const brand of document.querySelectorAll('.brand')) brand.textContent = data.store.name;
      document.querySelector('.hero h1').textContent = data.store.name;
      document.querySelectorAll('#story,#about,#faq,.hero .label,.hero h1+p,.ribbon,.collection>.label').forEach(element=>element.hidden=true);
      document.querySelector('.collection h2').textContent = 'Shop fragrances';
    }
    grid.innerHTML = products.map(item=>`<article class="card">
      <button class="photo" style="background-position:${item.image_position}% center" data-product data-sku="${item.sku}" aria-label="View ${text(item.name)}"></button>
      <h3>${text(item.name)}</h3><p>${text(item.size)} · ${format(item.price_cents)}</p>
      <button class="add" data-sku="${item.sku}" data-change="1">Add to bag</button></article>`).join('') || '<p>No products are available yet.</p>';
    saveBag();
  } catch {
    grid.textContent = 'The catalogue is currently unavailable.';
  }
}
loadCatalogue();

if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.remove('pending');
      observer.unobserve(entry.target);
    }
  }), {threshold:0.1});
  document.querySelectorAll('.reveal').forEach(section => {
    section.classList.add('pending');
    observer.observe(section);
  });
}
const menuToggle = document.querySelector('#menu-toggle');
const infoMenu = document.querySelector('#info-menu');
const menuRow = infoMenu.parentElement;
function setMenuOpen(open) {
  menuToggle.setAttribute('aria-expanded',String(open));
  menuRow.inert = !open;
  menuRow.classList.toggle('is-open',open);
}
menuToggle.addEventListener('click',()=>setMenuOpen(menuRow.inert));
infoMenu.addEventListener('click',event => {
  if (event.target.closest('a')) setMenuOpen(false);
});
document.addEventListener('click',event => {
  if (!menuRow.inert && !event.target.closest('.site-menu, #menu-toggle')) setMenuOpen(false);
});
document.addEventListener('keydown',event => {
  if (event.key==='Escape' && !menuRow.inert) {
    setMenuOpen(false);
    menuToggle.focus();
  }
});
