/* Tienda online: catálogo público y pedido por WhatsApp */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n) => (Number.isInteger(n) ? String(n) : n.toLocaleString('es-AR'));

const token = new URLSearchParams(location.search).get('c') || '';
const qs = token ? `?c=${encodeURIComponent(token)}` : '';
const CART_KEY = 'tienda_carrito_' + (token || 'publico');

const state = { info: null, products: [], cat: '', q: '', cart: loadCart() };

function loadCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || {};
  } catch {
    return {};
  }
}
function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
  } catch {
    /* modo privado: el carrito vive solo en esta pestaña */
  }
}

async function api(path, opts = {}) {
  const res = await fetch('/api/shop' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function notice(text, cls = '') {
  $('#shopNotice').insertAdjacentHTML('beforeend', `<div class="notice ${cls}">${esc(text)}</div>`);
}

// ---------- Catálogo ----------
function visibleProducts() {
  const q = state.q.toLowerCase();
  return state.products.filter(
    (p) =>
      (!state.cat || String(p.category_id) === state.cat) &&
      (!q || [p.name, p.brand, p.presentation, p.category].some((v) => String(v || '').toLowerCase().includes(q)))
  );
}

function stockBadge(p) {
  const cls = !p.available ? 'out' : p.label === 'Últimas unidades' ? 'warn' : 'ok';
  return `<span class="badge ${cls}">${esc(p.label)}</span>`;
}

function controls(p) {
  const q = state.cart[p.id] || 0;
  if (!p.available) return '<div class="add"><button disabled>Sin stock</button></div>';
  if (!q)
    return `<div class="add"><button data-add="${p.id}">Agregar</button>${p.units_per_pack > 1 ? `<button class="pack-btn" data-pack="${p.id}">+ Bulto x${p.units_per_pack}</button>` : ''}</div>`;
  return `<div class="stepper"><button data-dec="${p.id}" aria-label="Quitar uno">−</button>
    <input data-qty="${p.id}" value="${q}" inputmode="decimal" aria-label="Cantidad"><button data-inc="${p.id}" aria-label="Agregar uno">+</button></div>`;
}

function renderProducts() {
  const list = visibleProducts();
  const showPrices = state.info.show_prices;
  $('#products').innerHTML = list.length
    ? list
        .map(
          (p) => `<div class="card ${p.available ? '' : 'out'}" data-card="${p.id}">
        <div class="img">${p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">` : '🍾'}</div>
        <div class="body">
          <div class="name">${esc(p.name)}</div>
          <div class="sub">${esc([p.brand, p.presentation].filter(Boolean).join(' · '))}</div>
          ${stockBadge(p)}
          ${showPrices ? `<div class="price">${money(p.price)}</div>${p.pack_price ? `<div class="pack">Bulto x${p.units_per_pack}: ${money(p.pack_price)}</div>` : ''}` : ''}
          <div data-ctrl="${p.id}">${controls(p)}</div>
        </div></div>`
        )
        .join('')
    : '<div class="empty">No encontramos productos con esa búsqueda</div>';
}

function refreshCard(id) {
  const p = state.products.find((x) => x.id === id);
  const el = document.querySelector(`[data-ctrl="${id}"]`);
  if (p && el) el.innerHTML = controls(p);
}

function setQty(id, q) {
  q = Math.max(0, Math.round(q * 100) / 100);
  if (q) state.cart[id] = q;
  else delete state.cart[id];
  saveCart();
  refreshCard(id);
  renderCartBar();
  if (!$('#drawer').hidden) renderCart();
}

// ---------- Carrito ----------
function cartLines() {
  return Object.entries(state.cart)
    .map(([id, q]) => ({ p: state.products.find((x) => x.id === Number(id)), q }))
    .filter((l) => l.p && l.p.available);
}
const cartTotal = () => cartLines().reduce((a, l) => a + (l.p.price || 0) * l.q, 0);

function renderCartBar() {
  const lines = cartLines();
  $('#cartBar').hidden = !lines.length;
  $('#cartCount').textContent = lines.length;
  $('#cartTotal').textContent = state.info.show_prices ? money(cartTotal()) : '';
}

function renderCart() {
  const lines = cartLines();
  const showPrices = state.info.show_prices;
  $('#cartItems').innerHTML = lines.length
    ? lines
        .map(
          ({ p, q }) => `<div class="line">${p.image_url ? `<img src="${esc(p.image_url)}" alt="">` : '<div class="noimg">🍾</div>'}
        <div class="info"><b>${esc(p.name)}</b><span class="muted small">${esc([p.presentation, showPrices && `${money(p.price)} c/u`].filter(Boolean).join(' · '))}</span>
          ${showPrices ? `<div><b>${money(p.price * q)}</b></div>` : ''}</div>
        <div class="stepper"><button data-dec="${p.id}">−</button><input data-qty="${p.id}" value="${q}" inputmode="decimal"><button data-inc="${p.id}">+</button></div></div>`
        )
        .join('')
    : '<div class="empty">Tu pedido está vacío</div>';
  const min = state.info.min_order;
  const total = cartTotal();
  $('#cartSum').innerHTML = showPrices
    ? `<span>Total</span><span>${money(total)}</span>`
    : '<span class="muted" style="font-size:14px;font-weight:400">Te confirmamos los precios por WhatsApp</span>';
  if (showPrices && min && total < min) $('#cartSum').insertAdjacentHTML('afterend', `<div class="notice" id="minNotice">Pedido mínimo: ${money(min)}</div>`);
}

function openDrawer() {
  document.querySelectorAll('#minNotice').forEach((e) => e.remove());
  renderCart();
  $('#drawer').hidden = false;
}

// ---------- Eventos ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  const id = Number(d.add || d.pack || d.inc || d.dec);
  if (id) {
    const p = state.products.find((x) => x.id === id);
    const cur = state.cart[id] || 0;
    if (d.add) setQty(id, 1);
    if (d.pack) setQty(id, cur + (p ? p.units_per_pack : 1));
    if (d.inc) setQty(id, cur + 1);
    if (d.dec) setQty(id, cur - 1);
  }
});
document.addEventListener('change', (e) => {
  const id = Number(e.target.dataset.qty);
  if (id) setQty(id, Number(String(e.target.value).replace(',', '.')) || 0);
});
$('#q').addEventListener('input', (e) => {
  state.q = e.target.value;
  renderProducts();
});
$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.cat = b.dataset.cat;
  document.querySelectorAll('#cats button').forEach((x) => x.classList.toggle('active', x === b));
  renderProducts();
});
$('#cartBar').onclick = openDrawer;
$('#closeDrawer').onclick = () => ($('#drawer').hidden = true);
$('#drawer').addEventListener('mousedown', (e) => e.target.id === 'drawer' && ($('#drawer').hidden = true));
$('#doneClose').onclick = () => ($('#doneBox').hidden = true);

$('#orderForm').onsubmit = async (e) => {
  e.preventDefault();
  const lines = cartLines();
  if (!lines.length) return;
  const f = Object.fromEntries(new FormData(e.target));
  $('#orderError').textContent = '';
  $('#sendBtn').disabled = true;
  // En celulares, abrir la ventana antes del "await" evita que el navegador la bloquee
  const waWindow = state.info.has_whatsapp && window.innerWidth > 700 ? window.open('', '_blank') : null;
  try {
    const r = await api('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ c: token, ...f, items: lines.map((l) => ({ product_id: l.p.id, quantity: l.q })) }),
    });
    try {
      localStorage.setItem('tienda_datos', JSON.stringify({ name: f.name, phone: f.phone, address: f.address }));
    } catch {
      /* ignorar */
    }
    state.cart = {};
    saveCart();
    renderProducts();
    renderCartBar();
    $('#drawer').hidden = true;
    $('#doneTitle').textContent = `¡Pedido N° ${r.id} registrado!`;
    $('#doneText').textContent = r.whatsapp_url
      ? 'Ahora envialo por WhatsApp para que te lo confirmemos.'
      : 'Te vamos a contactar para confirmarlo.';
    $('#doneWa').hidden = !r.whatsapp_url;
    if (r.whatsapp_url) {
      $('#doneWa').href = r.whatsapp_url;
      if (waWindow) waWindow.location = r.whatsapp_url;
      else location.href = r.whatsapp_url;
    }
    $('#doneBox').hidden = false;
  } catch (err) {
    if (waWindow) waWindow.close();
    $('#orderError').textContent = err.message;
  } finally {
    $('#sendBtn').disabled = false;
  }
};

// ---------- Inicio ----------
(async () => {
  try {
    state.info = await api('/info' + qs);
  } catch (err) {
    $('#products').innerHTML = '';
    $('.shop-filters').hidden = true;
    notice(err.message, 'error');
    return;
  }
  const i = state.info;
  document.title = `${i.business_name} — Catálogo`;
  $('#shopName').textContent = i.business_name;
  $('#shopHello').textContent = i.customer ? `Hola, ${i.customer.name} 👋` : [i.business_address, i.business_phone].filter(Boolean).join(' · ');
  if (i.message) notice(i.message, 'info');
  if (i.show_prices && i.min_order) notice(`Pedido mínimo: ${money(i.min_order)}`);
  $('#cats').innerHTML =
    '<button class="active" data-cat="">Todo</button>' + i.categories.map((c) => `<button data-cat="${c.id}">${esc(c.name)}</button>`).join('');

  // Datos del formulario: del cliente (link personal) o de un pedido anterior en este dispositivo
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('tienda_datos')) || {};
  } catch {
    /* ignorar */
  }
  const form = $('#orderForm');
  const pre = i.customer || saved;
  form.name.value = pre.name || '';
  form.phone.value = pre.phone || saved.phone || '';
  form.address.value = pre.address || saved.address || '';
  if (i.customer) {
    form.phone.required = false;
    $('#phoneReq').hidden = true;
  } else form.phone.required = true;
  if (!i.has_whatsapp) $('#sendBtn').textContent = 'Enviar pedido';

  try {
    state.products = await api('/products' + qs);
  } catch (err) {
    notice(err.message, 'error');
    return;
  }
  renderProducts();
  renderCartBar();
})();
