/* Sistema Bebidas - interfaz web (SPA sin dependencias) */
'use strict';

// ======================= Utilidades =======================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => '$ ' + fmt.format(Number(n) || 0);
const qty = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : fmt.format(Number(n)));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).trim();
  // Acepta "1.234,56" y "1234.56"
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return isNaN(n) ? 0 : n;
};
const today = () => new Date().toLocaleDateString('sv-SE');
const monthStart = () => today().slice(0, 8) + '01';
const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
const signed = (n) => `<span class="${n > 0.004 ? 'pos' : n < -0.004 ? 'neg' : ''}">${money(n)}</span>`;

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) {
    showAuth('login');
    throw new Error('Tu sesión expiró. Volvé a iniciar sesión.');
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

/** Envuelve un handler async mostrando errores como toast */
const safe = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    toast(e.message, 'error');
  }
};

/**
 * Modal genérico. actions: [{label, cls, onClick(el) -> false para no cerrar}]
 * Devuelve { el, close }.
 */
const openModals = new Set();
function modal({ title, body, wide = false, actions = [], onOpen }) {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog">
    <header><h3>${esc(title)}</h3><button class="btn icon" data-close>✕</button></header>
    <div class="content">${body}</div>
    ${actions.some(Boolean) ? '<footer></footer>' : ''}</div>`;
  const close = () => {
    root.remove();
    document.removeEventListener('keydown', onKey);
    openModals.delete(close);
  };
  openModals.add(close);
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  root.addEventListener('mousedown', (e) => e.target === root && close());
  $('[data-close]', root).onclick = close;
  const footer = $('footer', root);
  actions.filter(Boolean).forEach((a) => {
    const b = document.createElement('button');
    b.className = `btn ${a.cls || ''}`;
    b.textContent = a.label;
    b.onclick = async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try {
        const r = await a.onClick(root);
        if (r !== false) close();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        b.disabled = false;
      }
    };
    footer.appendChild(b);
  });
  $('#modalRoot').appendChild(root);
  if (onOpen) onOpen(root, close);
  const first = $('input:not([type=hidden]):not([type=file]), select, textarea', root);
  if (first) setTimeout(() => first.focus(), 30);
  // Enter en un input de formulario dispara la acción principal
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !e.target.dataset.noenter) {
      const primary = $('footer .btn.primary', root);
      if (primary) {
        e.preventDefault();
        primary.click();
      }
    }
  });
  return { el: root, close };
}

function confirmDialog(message, okLabel = 'Confirmar') {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal({
      title: 'Confirmar',
      body: `<p>${esc(message)}</p>`,
      actions: [
        { label: 'Cancelar', onClick: () => { answered = true; resolve(false); } },
        { label: okLabel, cls: 'primary', onClick: () => { answered = true; resolve(true); } },
      ],
    });
    const obs = new MutationObserver(() => {
      if (!document.body.contains(m.el)) {
        obs.disconnect();
        if (!answered) resolve(false);
      }
    });
    obs.observe($('#modalRoot'), { childList: true });
  });
}

/** Lee los inputs con name="" dentro de un elemento y devuelve un objeto */
function formData(el) {
  const out = {};
  $$('[name]', el).forEach((i) => {
    if (i.type === 'file') return;
    if (i.type === 'checkbox') out[i.name] = i.checked;
    else out[i.name] = i.value;
  });
  return out;
}

/** Descarga un archivo del servidor (PDF, Excel) sin abrir otra pestaña */
function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const field = (label, input, cls = '') => `<div class="field ${cls}"><label>${esc(label)}</label>${input}</div>`;
const opt = (value, label, selected) =>
  `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`;

// Cachés simples
const cache = {
  async lists(force) {
    if (force || !this._lists) this._lists = await api('/price-lists');
    return this._lists;
  },
  async categories(force) {
    if (force || !this._cats) this._cats = await api('/categories');
    return this._cats;
  },
  invalidate() {
    this._lists = null;
    this._cats = null;
  },
};
const defaultList = (lists) => (lists.find((l) => l.is_default) || lists[0] || {}).id;

async function refreshTopBalances() {
  try {
    const { balances } = await api('/cash?limit=1');
    $('#topBalances').innerHTML = `<span class="pill">💵 Efectivo <b>${money(balances.efectivo)}</b></span>
      <span class="pill">🏦 Transferencia <b>${money(balances.transferencia)}</b></span>`;
  } catch {
    /* ignorar */
  }
}

// ======================= Buscador de productos =======================
/**
 * Convierte un input en buscador de productos con soporte para lector de código de barras.
 * Enter con un código exacto agrega directo; si no, toma la sugerencia seleccionada.
 */
function productPicker(input, { listId, onPick }) {
  const wrap = input.parentElement;
  wrap.classList.add('search-wrap');
  const box = document.createElement('div');
  box.className = 'suggestions';
  box.hidden = true;
  wrap.appendChild(box);
  let items = [];
  let sel = 0;

  const render = () => {
    if (!items.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.innerHTML = items
      .map(
        (p, i) => `<div class="item ${i === sel ? 'sel' : ''}" data-i="${i}">
          ${p.image_url ? `<img src="${esc(p.image_url)}">` : '<div class="noimg">🍾</div>'}
          <div class="grow"><div><b>${esc(p.name)}</b> <span class="muted">${esc(p.presentation || '')}</span></div>
          <div class="muted">${esc(p.barcode || p.code || '')} · Stock: ${qty(p.stock)}</div></div>
          <div><b>${money(p.price)}</b></div></div>`
      )
      .join('');
  };
  const pick = (p) => {
    items = [];
    render();
    input.value = '';
    onPick(p);
    input.focus();
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      items = [];
      return render();
    }
    try {
      items = await api(`/products?q=${encodeURIComponent(q)}&limit=15&price_list_id=${listId() || ''}`);
      sel = 0;
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  }, 200);

  input.addEventListener('input', search);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown') {
      sel = Math.min(sel + 1, items.length - 1);
      render();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      sel = Math.max(sel - 1, 0);
      render();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      items = [];
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      try {
        const p = await api(`/products/barcode/${encodeURIComponent(q)}?price_list_id=${listId() || ''}`);
        return pick(p);
      } catch {
        /* no es un código exacto */
      }
      if (items[sel]) return pick(items[sel]);
      toast('No se encontró el producto', 'error');
    }
  });
  box.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.item');
    if (it) {
      e.preventDefault();
      pick(items[Number(it.dataset.i)]);
    }
  });
  input.addEventListener('blur', () => setTimeout(() => (box.hidden = true), 150));
  input.addEventListener('focus', () => items.length && (box.hidden = false));
}

// ======================= Vistas =======================
const views = {};

// ---------- Inicio ----------
views[''] = {
  title: 'Inicio',
  async render(view) {
    const d = await api('/dashboard');
    const max = Math.max(1, ...d.last7.map((x) => x.total));
    const web = await api('/shop/pending').catch(() => ({ n: 0 }));
    view.innerHTML = `${web.n ? `<a href="#/pedidos" class="card" style="display:block;text-decoration:none;color:inherit;background:var(--warn-soft);border-color:#f3c98b">🛍️ Tenés <b>${web.n} pedido${web.n > 1 ? 's' : ''} web</b> pendiente${web.n > 1 ? 's' : ''} de la tienda online. <u>Ver pedidos</u></a>` : ''}
      <div class="grid cols-4">
        <div class="stat"><div class="label">💵 Caja efectivo</div><div class="value">${money(d.boxes.efectivo)}</div></div>
        <div class="stat"><div class="label">🏦 Caja transferencia</div><div class="value">${money(d.boxes.transferencia)}</div></div>
        <div class="stat ok"><div class="label">Clientes nos deben</div><div class="value">${money(d.receivable.total)}</div><div class="sub">${d.receivable.count} clientes con saldo</div></div>
        <div class="stat danger"><div class="label">Debemos a proveedores</div><div class="value">${money(d.payable.total)}</div><div class="sub">${d.payable.count} proveedores con saldo</div></div>
        <div class="stat"><div class="label">Ventas de hoy</div><div class="value">${money(d.sales_today.total)}</div><div class="sub">${d.sales_today.count} ventas</div></div>
        <div class="stat"><div class="label">Ventas del mes</div><div class="value">${money(d.sales_month.total)}</div><div class="sub">${d.sales_month.count} ventas</div></div>
        <div class="stat ok"><div class="label">Ganancia bruta del mes</div><div class="value">${money(d.sales_month.profit)}</div><div class="sub">Ventas - costo de lo vendido</div></div>
        <div class="stat"><div class="label">Stock valorizado (costo)</div><div class="value">${money(d.stock_value.total)}</div><div class="sub">${d.stock_value.count} productos con stock</div></div>
      </div>
      <div class="toolbar" style="margin-top:16px">
        <a class="btn primary lg" href="#/vender">🛒 Nueva venta</a>
        <a class="btn lg" href="#/comprar">📦 Nueva compra</a>
        <a class="btn lg" href="#/catalogo">🍾 Catálogo</a>
      </div>
      <div class="grid cols-3" style="margin-top:4px">
        <div class="card"><h2>Ventas últimos 7 días</h2>
          ${d.last7.length ? d.last7.map((x) => `<div style="margin:6px 0"><div class="summary-row"><span>${esc(x.day)}</span><b>${money(x.total)}</b></div>
            <div style="height:8px;background:var(--primary-soft);border-radius:4px"><div style="height:8px;width:${(x.total / max) * 100}%;background:var(--primary);border-radius:4px"></div></div></div>`).join('') : '<div class="empty">Sin ventas</div>'}
        </div>
        <div class="card"><h2>Más vendidos (30 días)</h2>
          ${d.top_products.length ? `<table class="table"><tbody>${d.top_products.map((p) => `<tr><td>${esc(p.description)}</td><td class="n">${qty(p.qty)} u.</td><td class="n">${money(p.total)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Sin datos</div>'}
        </div>
        <div class="card"><h2>⚠️ Stock bajo</h2>
          ${d.low_stock.length ? `<table class="table"><thead><tr><th>Producto</th><th class="n">Stock</th><th class="n">Mín.</th></tr></thead><tbody>${d.low_stock.map((p) => `<tr><td>${esc(p.name)}</td><td class="n neg">${qty(p.stock)}</td><td class="n">${qty(p.min_stock)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Todo en orden 👍</div>'}
        </div>
      </div>`;
  },
};

// ---------- Vender (punto de venta) ----------
const pos = { cart: [], customer_id: '', customer_name: '', price_list_id: '', discount: 0, paid_cash: '', paid_transfer: '', notes: '', quote_id: null };

views.vender = {
  title: 'Vender',
  async render(view) {
    const [lists, customers] = await Promise.all([cache.lists(), api('/customers')]);
    if (!pos.price_list_id) pos.price_list_id = defaultList(lists);
    view.innerHTML = `
      <div class="pos-layout">
        <div>
          ${pos.quote_id ? `<div class="card" style="background:var(--primary-soft);border-color:var(--primary)">
            📄 Trabajando sobre el <b>presupuesto #${pos.quote_id}</b>: podés modificarlo y guardarlo, o confirmar la venta.
            <div class="toolbar" style="margin:8px 0 0"><button class="btn sm" id="quoteReprice">🔄 Actualizar a precios actuales</button>
            <button class="btn sm" id="quoteUnlink">Desvincular</button></div></div>` : ''}
          <div class="card">
            <div class="field"><input id="posSearch" class="big" placeholder="🔍 Escaneá el código de barras o buscá por nombre / código" autocomplete="off"></div>
          </div>
          <div class="card" style="padding:0"><div class="table-wrap"><table class="table">
            <thead><tr><th></th><th>Producto</th><th class="n">Stock</th><th class="n">Cantidad</th><th class="n">Precio unit.</th><th class="n">Subtotal</th><th></th></tr></thead>
            <tbody id="cartBody"></tbody></table></div></div>
        </div>
        <div>
          <div class="card">
            ${field('Cliente', `<select id="posCustomer"><option value="">Consumidor final</option>${customers.map((c) => opt(c.id, c.name, pos.customer_id)).join('')}</select>`)}
            <div id="customerInfo" class="muted" style="margin:6px 0 10px"></div>
            ${field('Lista de precios', `<select id="posList">${lists.map((l) => opt(l.id, l.name, pos.price_list_id)).join('')}</select>`)}
          </div>
          <div class="card">
            <div class="summary-row"><span>Subtotal</span><b id="posSubtotal"></b></div>
            <div class="summary-row" style="align-items:center"><span>Descuento $</span><input id="posDiscount" style="width:120px;text-align:right" value="${pos.discount || ''}" placeholder="0"></div>
            <div class="total-box" id="posTotal"></div>
            <hr style="border:none;border-top:1px solid var(--border)">
            <div class="toolbar" style="margin-bottom:8px">
              <button class="btn sm" data-fill="efectivo">Todo efectivo</button>
              <button class="btn sm" data-fill="transferencia">Todo transferencia</button>
              <button class="btn sm" data-fill="cc">Todo a cuenta</button>
            </div>
            <div class="pay-grid">
              ${field('💵 Efectivo', `<input id="payCash" value="${pos.paid_cash}" placeholder="0">`)}
              ${field('🏦 Transferencia', `<input id="payTransfer" value="${pos.paid_transfer}" placeholder="0">`)}
            </div>
            <div id="payInfo" style="margin:10px 0"></div>
            ${field('Notas', `<input id="posNotes" value="${esc(pos.notes)}" placeholder="Opcional">`)}
            <div class="toolbar" style="margin-top:12px">
              <button class="btn" id="posClear">Vaciar</button><span class="spacer"></span>
              <button class="btn" id="posQuote" title="Guardar como presupuesto: no descuenta stock ni mueve caja">📄 ${pos.quote_id ? 'Guardar presupuesto' : 'Presupuesto'}</button>
              <button class="btn ok lg" id="posConfirm">✔ Confirmar venta</button>
            </div>
          </div>
        </div>
      </div>`;

    const customerById = (id) => customers.find((c) => String(c.id) === String(id));
    const totals = () => {
      const subtotal = round2(pos.cart.reduce((a, i) => a + i.quantity * i.unit_price, 0));
      const discount = Math.min(num(pos.discount), subtotal);
      return { subtotal, total: round2(subtotal - discount) };
    };

    const renderCart = () => {
      const body = $('#cartBody');
      if (!pos.cart.length) body.innerHTML = '<tr><td colspan="7" class="empty">Escaneá o buscá productos para agregarlos</td></tr>';
      else
        body.innerHTML = pos.cart
          .map(
            (i, idx) => `<tr>
            <td>${i.image_url ? `<img class="thumb" src="${esc(i.image_url)}">` : '<div class="thumb"></div>'}</td>
            <td><b>${esc(i.name)}</b>${i.units_per_pack > 1 ? `<br><button class="btn sm" data-pack="${idx}">+ bulto x${i.units_per_pack}</button>` : ''}</td>
            <td class="n ${i.stock - i.quantity < 0 ? 'neg' : 'muted'}">${qty(i.stock)}</td>
            <td class="n"><input class="cart-qty" data-qty="${idx}" value="${i.quantity}"></td>
            <td class="n"><input class="cart-price" data-price="${idx}" value="${i.unit_price}"></td>
            <td class="n"><b>${money(i.quantity * i.unit_price)}</b></td>
            <td><button class="btn sm danger" data-del="${idx}">✕</button></td></tr>`
          )
          .join('');
      renderTotals();
    };

    const renderTotals = () => {
      const { subtotal, total } = totals();
      $('#posSubtotal').textContent = money(subtotal);
      $('#posTotal').textContent = money(total);
      const cash = num(pos.paid_cash);
      const transfer = num(pos.paid_transfer);
      const rest = round2(total - cash - transfer);
      let html = '';
      if (rest > 0.004) html = `<div class="badge warn" style="font-size:13px">A cuenta corriente: ${money(rest)}</div>`;
      else if (rest < -0.004) html = `<div class="badge ok" style="font-size:13px">Vuelto: ${money(-rest)}</div>`;
      else if (total > 0) html = '<div class="badge ok" style="font-size:13px">Pagado completo</div>';
      const c = customerById(pos.customer_id);
      if (rest > 0.004 && !c) html += '<div class="neg" style="margin-top:6px">Elegí un cliente para dejar saldo en cuenta corriente</div>';
      if (c && rest > 0.004 && c.credit_limit > 0 && c.balance + rest > c.credit_limit)
        html += `<div class="neg" style="margin-top:6px">⚠️ Supera el límite de crédito (${money(c.credit_limit)})</div>`;
      $('#payInfo').innerHTML = html;
    };

    const renderCustomer = () => {
      const c = customerById(pos.customer_id);
      $('#customerInfo').innerHTML = c
        ? `Saldo CC: ${signed(c.balance)} ${c.credit_limit ? `· Límite: ${money(c.credit_limit)}` : ''} ${c.phone ? '· ' + esc(c.phone) : ''}`
        : '';
    };

    const reprice = safe(async () => {
      for (const i of pos.cart) {
        const p = await api(`/products/${i.product_id}`);
        const pr = p.prices.find((x) => String(x.price_list_id) === String(pos.price_list_id));
        if (pr) i.unit_price = pr.price;
      }
      renderCart();
    });

    productPicker($('#posSearch'), {
      listId: () => pos.price_list_id,
      onPick: (p) => {
        const ex = pos.cart.find((i) => i.product_id === p.id);
        if (ex) ex.quantity += 1;
        else
          pos.cart.push({ product_id: p.id, name: p.name, quantity: 1, unit_price: p.price, stock: p.stock, image_url: p.image_url, units_per_pack: p.units_per_pack });
        renderCart();
      },
    });

    $('#cartBody').addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.qty !== undefined) {
        const q = num(t.value);
        if (q <= 0) pos.cart.splice(Number(t.dataset.qty), 1);
        else pos.cart[t.dataset.qty].quantity = q;
      }
      if (t.dataset.price !== undefined) pos.cart[t.dataset.price].unit_price = round2(num(t.value));
      renderCart();
    });
    $('#cartBody').addEventListener('click', (e) => {
      const t = e.target;
      if (t.dataset.del !== undefined) pos.cart.splice(Number(t.dataset.del), 1);
      else if (t.dataset.pack !== undefined) pos.cart[t.dataset.pack].quantity += pos.cart[t.dataset.pack].units_per_pack;
      else return;
      renderCart();
    });
    $('#posCustomer').onchange = (e) => {
      pos.customer_id = e.target.value;
      const c = customerById(pos.customer_id);
      if (c && c.price_list_id && String(c.price_list_id) !== String(pos.price_list_id)) {
        pos.price_list_id = c.price_list_id;
        $('#posList').value = c.price_list_id;
        reprice();
      }
      renderCustomer();
      renderTotals();
    };
    $('#posList').onchange = (e) => {
      pos.price_list_id = e.target.value;
      reprice();
    };
    $('#posDiscount').oninput = (e) => {
      pos.discount = e.target.value;
      renderTotals();
    };
    $('#payCash').oninput = (e) => {
      pos.paid_cash = e.target.value;
      renderTotals();
    };
    $('#payTransfer').oninput = (e) => {
      pos.paid_transfer = e.target.value;
      renderTotals();
    };
    $('#posNotes').oninput = (e) => (pos.notes = e.target.value);
    $$('[data-fill]', view).forEach(
      (b) =>
        (b.onclick = () => {
          const { total } = totals();
          pos.paid_cash = b.dataset.fill === 'efectivo' ? String(total) : '';
          pos.paid_transfer = b.dataset.fill === 'transferencia' ? String(total) : '';
          $('#payCash').value = pos.paid_cash;
          $('#payTransfer').value = pos.paid_transfer;
          renderTotals();
        })
    );
    const reset = () => {
      Object.assign(pos, { cart: [], customer_id: '', customer_name: '', discount: 0, paid_cash: '', paid_transfer: '', notes: '', price_list_id: defaultList(lists), quote_id: null });
    };
    $('#posClear').onclick = () => {
      reset();
      views.vender.render(view);
    };
    $('#posConfirm').onclick = safe(async () => {
      if (!pos.cart.length) throw new Error('Agregá productos a la venta');
      const { total } = totals();
      if (!pos.paid_cash && !pos.paid_transfer && !pos.customer_id) {
        // Sin pago indicado y sin cliente: asumimos efectivo
        pos.paid_cash = String(total);
      }
      const r = await api('/sales', {
        method: 'POST',
        body: {
          customer_id: pos.customer_id || null,
          price_list_id: pos.price_list_id,
          items: pos.cart.map((i) => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price })),
          discount: num(pos.discount),
          paid_cash: num(pos.paid_cash),
          paid_transfer: num(pos.paid_transfer),
          notes: pos.notes,
          quote_id: pos.quote_id,
        },
      });
      reset();
      refreshTopBalances();
      modal({
        title: `Venta #${r.id} registrada`,
        body: `<div class="total-box">${money(r.total)}</div>
          ${r.change ? `<p class="total-box pos" style="font-size:22px">Vuelto: ${money(r.change)}</p>` : ''}
          ${r.on_account ? `<p>Quedó en cuenta corriente: <b>${money(r.on_account)}</b></p>` : ''}`,
        actions: [
          { label: '📃 Remito', onClick: () => { remitoForm(r.id); return false; } },
          { label: '⬇️ PDF', onClick: () => { download(`/api/sales/${r.id}/pdf`); return false; } },
          { label: '🖨️ Imprimir', onClick: () => { window.open(`/api/sales/${r.id}/ticket`, '_blank'); return false; } },
          { label: 'Nueva venta', cls: 'primary' },
        ],
      });
      views.vender.render(view);
    });

    $('#posQuote').onclick = safe(async () => {
      if (!pos.cart.length) throw new Error('Agregá productos al presupuesto');
      const settings = await api('/settings');
      const c = customerById(pos.customer_id);
      modal({
        title: pos.quote_id ? `Guardar presupuesto #${pos.quote_id}` : 'Nuevo presupuesto',
        body: `<p>Total: <b>${money(totals().total)}</b> · ${pos.cart.length} productos. No descuenta stock ni mueve la caja.</p>
          <div class="form-grid">
          ${c ? field('Cliente', `<input value="${esc(c.name)}" disabled>`) : field('Nombre del cliente (opcional)', `<input name="customer_name" value="${esc(pos.customer_name)}" placeholder="Ej: Juan Pérez - Evento sábado">`)}
          ${field('Validez (días)', `<input name="valid_days" inputmode="numeric" value="${esc(settings.quote_valid_days || 7)}">`)}
          ${field('Observaciones', `<textarea name="notes" rows="2" placeholder="Ej: Entrega a domicilio incluida">${esc(pos.notes)}</textarea>`, 'full')}</div>`,
        actions: [
          { label: 'Cancelar' },
          {
            label: 'Guardar presupuesto',
            cls: 'primary',
            onClick: async (el) => {
              const f = formData(el);
              const body = {
                customer_id: pos.customer_id || null,
                customer_name: f.customer_name,
                price_list_id: pos.price_list_id,
                items: pos.cart.map((i) => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price })),
                discount: num(pos.discount),
                valid_days: num(f.valid_days),
                notes: f.notes,
              };
              const r = pos.quote_id
                ? await api('/quotes/' + pos.quote_id, { method: 'PUT', body })
                : await api('/quotes', { method: 'POST', body });
              reset();
              views.vender.render(view);
              modal({
                title: `Presupuesto #${r.id} guardado`,
                body: `<div class="total-box">${money(r.total)}</div><p class="muted">Lo encontrás en <a href="#/presupuestos">Presupuestos</a> para imprimirlo o pasarlo a venta.</p>`,
                actions: [
                  { label: '⬇️ Descargar PDF', onClick: () => { download(`/api/quotes/${r.id}/pdf`); return false; } },
                  { label: '🖨️ Imprimir', onClick: () => { window.open(`/api/quotes/${r.id}/print`, '_blank'); return false; } },
                  { label: 'Listo', cls: 'primary' },
                ],
              });
            },
          },
        ],
      });
    });
    if (pos.quote_id) {
      $('#quoteReprice').onclick = reprice;
      $('#quoteUnlink').onclick = () => {
        pos.quote_id = null;
        views.vender.render(view);
      };
    }

    renderCustomer();
    renderCart();
    $('#posSearch').focus();
  },
};

views.pedidos = {
  title: 'Pedidos web',
  render: (view, params) => views.presupuestos.render(view, params, 'web'),
};

/** Muestra en el menú cuántos pedidos web hay pendientes */
async function refreshPendingOrders() {
  try {
    const { n } = await api('/shop/pending');
    const el = $('#webBadge');
    el.textContent = n;
    el.hidden = !n;
  } catch {
    /* ignorar */
  }
}

/** Carga un presupuesto en Vender (para venderlo/editarlo, o como copia nueva si duplicate = true) */
async function openQuoteInPos(id, duplicate = false) {
  const q = await api('/quotes/' + id);
  const missing = q.items.filter((i) => !i.product_id);
  Object.assign(pos, {
    cart: q.items
      .filter((i) => i.product_id)
      .map((i) => ({
        product_id: i.product_id,
        name: i.description,
        quantity: i.quantity,
        unit_price: i.unit_price,
        stock: i.stock ?? 0,
        image_url: i.image ? `/uploads/${i.image}` : null,
        units_per_pack: i.units_per_pack || 1,
      })),
    customer_id: q.customer_id || '',
    customer_name: q.customer_id ? '' : q.customer_name || '',
    price_list_id: q.price_list_id || '',
    discount: q.discount || 0,
    paid_cash: '',
    paid_transfer: '',
    notes: q.notes || '',
    quote_id: duplicate ? null : q.id,
  });
  if (missing.length) toast(`${missing.length} productos del presupuesto ya no existen y no se cargaron`, 'error');
  if (location.hash === '#/vender') route();
  else location.hash = '#/vender';
}

// ---------- Presupuestos ----------
views.presupuestos = {
  title: 'Presupuestos',
  async render(view, params, source = '') {
    const web = source === 'web';
    const customers = await api('/customers?include_inactive=1');
    const from = new Date(Date.now() - 60 * 864e5).toLocaleDateString('sv-SE');
    view.innerHTML = `
      ${web ? `<div class="card" style="background:var(--primary-soft)">🛍️ Pedidos que hicieron los clientes desde la <b>tienda online</b>. Revisalos, tocá <b>🛒 Vender / editar</b> para ajustarlo y confirmar la venta (recién ahí se descuenta el stock).
        <div class="toolbar" style="margin:8px 0 0"><a class="btn sm" href="/tienda" target="_blank">Ver la tienda</a><a class="btn sm" href="#/config">Configurar tienda</a></div></div>` : ''}
      <div class="toolbar">
        <input type="date" id="fFrom" value="${from}"> <input type="date" id="fTo" value="${today()}">
        <select id="fCustomer"><option value="">Todos los clientes</option>${customers.map((c) => opt(c.id, c.name)).join('')}</select>
        <select id="fStatus"><option value="pendiente">Pendientes</option><option value="vendido">Pasados a venta</option><option value="anulado">Anulados</option><option value="">Todos</option></select>
        <span class="spacer"></span>${web ? '' : '<a class="btn primary" href="#/vender" id="qNew">📄 Nuevo presupuesto</a>'}
      </div>
      <p class="muted" style="margin-top:0" ${web ? 'hidden' : ''}>Los presupuestos se arman desde <b>Vender</b>: cargá los productos y tocá <b>📄 Presupuesto</b>. No descuentan stock ni mueven la caja hasta que los pasás a venta.</p>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="table">
        <thead><tr><th>N°</th><th>Fecha</th><th>Cliente</th><th>Lista</th><th class="n">Total</th><th>Válido hasta</th><th>Estado</th><th></th></tr></thead>
        <tbody id="qBody"></tbody></table></div></div>`;
    const badge = (q) => {
      if (q.status === 'vendido') return `<span class="badge ok">Venta #${q.sale_id}</span>`;
      if (q.status === 'anulado') return '<span class="badge danger">Anulado</span>';
      if (q.valid_until && q.valid_until < today()) return '<span class="badge warn">Vencido</span>';
      return '<span class="badge info">Pendiente</span>';
    };
    const load = safe(async () => {
      const qs = new URLSearchParams({ from: $('#fFrom').value, to: $('#fTo').value, customer_id: $('#fCustomer').value, status: $('#fStatus').value, source });
      const rows = await api('/quotes?' + qs);
      if (web) refreshPendingOrders();
      $('#qBody').innerHTML = rows.length
        ? rows
            .map(
              (q) => `<tr><td>${q.id}</td><td>${esc(q.date)}</td><td>${esc(q.customer_name || 'Consumidor final')}${q.source === 'web' ? ' <span class="badge warn">🛍️ Web</span>' : ''}
            ${q.contact_phone ? `<div class="muted" style="font-size:12px">📞 ${esc(q.contact_phone)}${q.contact_address ? ' · ' + esc(q.contact_address) : ''}</div>` : ''}${q.source === 'web' && q.notes ? `<div class="muted" style="font-size:12px">📝 ${esc(q.notes)}</div>` : ''}</td><td>${esc(q.price_list_name || '')}</td>
          <td class="n"><b>${money(q.total)}</b></td><td>${esc(q.valid_until ? q.valid_until.split('-').reverse().join('/') : '')}</td><td>${badge(q)}</td>
          <td class="actions"><a class="btn sm" href="/api/quotes/${q.id}/pdf" download>⬇️ PDF</a>
            <a class="btn sm" href="/api/quotes/${q.id}/print" target="_blank" title="Imprimir">🖨️</a>
            ${q.status === 'pendiente' ? `<button class="btn sm ok" data-open="${q.id}">🛒 Vender / editar</button>` : ''}
            <button class="btn sm" data-dup="${q.id}" title="Crear un presupuesto nuevo a partir de este">📋 Duplicar</button>
            ${q.status === 'pendiente' ? `<button class="btn sm danger" data-cancel="${q.id}">Anular</button>` : ''}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="8" class="empty">No hay presupuestos con esos filtros</td></tr>';
    });
    ['#fFrom', '#fTo', '#fCustomer', '#fStatus'].forEach((s) => ($(s).onchange = load));
    if ($('#qNew'))
      $('#qNew').onclick = () => {
        pos.quote_id = null;
      };
    $('#qBody').onclick = safe(async (e) => {
      const d = e.target.dataset;
      if (d.open) await openQuoteInPos(d.open);
      if (d.dup) await openQuoteInPos(d.dup, true);
      if (d.cancel && (await confirmDialog(`¿Anular el presupuesto #${d.cancel}?`, 'Anular'))) {
        await api(`/quotes/${d.cancel}/cancel`, { method: 'POST' });
        toast('Presupuesto anulado', 'ok');
        load();
      }
    });
    load();
  },
};

// ---------- Historial de ventas ----------
views.ventas = {
  title: 'Ventas',
  async render(view) {
    const customers = await api('/customers?include_inactive=1');
    view.innerHTML = `
      <div class="toolbar">
        <input type="date" id="fFrom" value="${monthStart()}"> <input type="date" id="fTo" value="${today()}">
        <select id="fCustomer"><option value="">Todos los clientes</option>${customers.map((c) => opt(c.id, c.name)).join('')}</select>
        <span class="spacer"></span><a class="btn primary" href="#/vender">🛒 Nueva venta</a>
      </div>
      <div class="grid cols-4" id="salesStats"></div>
      <div class="card" style="padding:0;margin-top:16px"><div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Fecha</th><th>Cliente</th><th>Lista</th><th class="n">Total</th><th class="n">Efectivo</th><th class="n">Transf.</th><th class="n">A cuenta</th><th>Estado</th><th></th></tr></thead>
        <tbody id="salesBody"></tbody></table></div></div>`;
    const load = safe(async () => {
      const q = new URLSearchParams({ from: $('#fFrom').value, to: $('#fTo').value, customer_id: $('#fCustomer').value });
      const rows = await api('/sales?' + q);
      const ok = rows.filter((r) => r.status === 'ok');
      const sum = (k) => ok.reduce((a, r) => a + r[k], 0);
      $('#salesStats').innerHTML = `
        <div class="stat"><div class="label">Total vendido</div><div class="value">${money(sum('total'))}</div><div class="sub">${ok.length} ventas</div></div>
        <div class="stat"><div class="label">Cobrado en efectivo</div><div class="value">${money(sum('paid_cash'))}</div></div>
        <div class="stat"><div class="label">Cobrado por transferencia</div><div class="value">${money(sum('paid_transfer'))}</div></div>
        <div class="stat warn"><div class="label">A cuenta corriente</div><div class="value">${money(sum('on_account'))}</div></div>`;
      $('#salesBody').innerHTML = rows.length
        ? rows
            .map(
              (s) => `<tr>
          <td>${s.id}</td><td>${esc(s.date)}</td><td>${esc(s.customer_name || 'Consumidor final')}</td><td>${esc(s.price_list_name || '')}</td>
          <td class="n"><b>${money(s.total)}</b></td><td class="n">${money(s.paid_cash)}</td><td class="n">${money(s.paid_transfer)}</td><td class="n">${money(s.on_account)}</td>
          <td>${s.status === 'ok' ? '<span class="badge ok">OK</span>' : '<span class="badge danger">Anulada</span>'}</td>
          <td class="actions"><button class="btn sm" data-view="${s.id}">Ver</button>
            ${s.remito_id ? `<a class="btn sm" href="/api/remitos/${s.remito_id}/pdf" download title="Descargar el remito">📃 Remito</a>` : s.status === 'ok' ? `<button class="btn sm" data-remito="${s.id}" title="Emitir remito">📃 Emitir remito</button>` : ''}
            <a class="btn sm" href="/api/sales/${s.id}/pdf" download title="Descargar PDF">⬇️ PDF</a>
            <a class="btn sm" href="/api/sales/${s.id}/ticket" target="_blank" title="Imprimir">🖨️</a>
            ${s.status === 'ok' ? `<button class="btn sm danger" data-cancel="${s.id}">Anular</button>` : ''}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="10" class="empty">No hay ventas en el período</td></tr>';
    });
    ['#fFrom', '#fTo', '#fCustomer'].forEach((s) => ($(s).onchange = load));
    $('#salesBody').onclick = safe(async (e) => {
      const id = e.target.dataset.view;
      if (id) {
        const s = await api('/sales/' + id);
        modal({
          title: `Venta #${s.id} — ${s.date}`,
          wide: true,
          body: `<p><b>Cliente:</b> ${esc(s.customer_name || 'Consumidor final')} · <b>Lista:</b> ${esc(s.price_list_name || '')}</p>
            <table class="table"><thead><tr><th>Producto</th><th class="n">Cant.</th><th class="n">P. unit.</th><th class="n">Subtotal</th></tr></thead>
            <tbody>${s.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="n">${qty(i.quantity)}</td><td class="n">${money(i.unit_price)}</td><td class="n">${money(i.subtotal)}</td></tr>`).join('')}</tbody></table>
            <div style="max-width:300px;margin-left:auto;margin-top:12px">
              <div class="summary-row"><span>Subtotal</span><span>${money(s.subtotal)}</span></div>
              ${s.discount ? `<div class="summary-row"><span>Descuento</span><span>-${money(s.discount)}</span></div>` : ''}
              <div class="summary-row"><b>Total</b><b>${money(s.total)}</b></div>
              <div class="summary-row muted"><span>Efectivo</span><span>${money(s.paid_cash)}</span></div>
              <div class="summary-row muted"><span>Transferencia</span><span>${money(s.paid_transfer)}</span></div>
              <div class="summary-row muted"><span>Cuenta corriente</span><span>${money(s.on_account)}</span></div></div>
            ${s.notes ? `<p><b>Notas:</b> ${esc(s.notes)}</p>` : ''}`,
          actions: [
            s.remito
              ? { label: '📃 Remito', onClick: () => { download(`/api/remitos/${s.remito.id}/pdf`); return false; } }
              : s.status === 'ok' && { label: '📃 Emitir remito', onClick: () => { remitoForm(s.id, load); } },
            { label: '⬇️ PDF', onClick: () => { download(`/api/sales/${s.id}/pdf`); return false; } },
            { label: '🖨️ Imprimir', onClick: () => { window.open(`/api/sales/${s.id}/ticket`, '_blank'); return false; } },
            { label: 'Cerrar', cls: 'primary' },
          ],
        });
      }
      if (e.target.dataset.remito) remitoForm(e.target.dataset.remito, load);
      const cid = e.target.dataset.cancel;
      if (cid && (await confirmDialog(`¿Anular la venta #${cid}? Se devuelve el stock y se revierten los movimientos de caja y cuenta corriente.`, 'Anular venta'))) {
        await api(`/sales/${cid}/cancel`, { method: 'POST' });
        toast('Venta anulada', 'ok');
        refreshTopBalances();
        load();
      }
    });
    load();
  },
};

// ---------- Remitos X ----------
/** Emite el remito de una venta y ofrece descargarlo */
async function remitoForm(saleId, onDone) {
  const [s, settings] = await Promise.all([api('/sales/' + saleId), api('/settings')]);
  if (s.remito) {
    download(`/api/remitos/${s.remito.id}/pdf`);
    return;
  }
  modal({
    title: `Remito X — Venta #${s.id}`,
    body: `<p>Cliente: <b>${esc(s.customer_name || 'Consumidor final')}</b> · ${s.items.length} productos · ${money(s.total)}</p>
      <div class="form-grid">
        ${field('Dirección de entrega', `<input name="delivery_address" value="${esc(s.customer_address)}" placeholder="Calle, número, localidad">`, 'full')}
        ${field('Observaciones', '<input name="notes" placeholder="Ej: Entregar por la tarde, transporte, chofer">', 'full')}
        <label class="check full"><input type="checkbox" name="valued" ${settings.remito_valued !== '0' ? 'checked' : ''}> Mostrar precios en el remito (valorizado)</label>
      </div>
      <p class="muted">No vuelve a descontar stock: la venta ya lo descontó. El número se asigna solo.</p>`,
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Emitir remito',
        cls: 'primary',
        onClick: async (el) => {
          const r = await api('/remitos', { method: 'POST', body: { sale_id: s.id, ...formData(el) } });
          toast(`Remito ${r.code} emitido`, 'ok');
          onDone && onDone();
          modal({
            title: `Remito ${r.code}`,
            body: '<p>El remito se emitió correctamente. Descargalo o imprimilo (sale con original y duplicado).</p>',
            actions: [
              { label: '🖨️ Imprimir', onClick: () => { window.open(`/api/remitos/${r.id}/pdf?inline=1`, '_blank'); return false; } },
              { label: '⬇️ Descargar PDF', cls: 'primary', onClick: () => { download(`/api/remitos/${r.id}/pdf`); } },
            ],
          });
        },
      },
    ],
  });
}

views.remitos = {
  title: 'Remitos',
  async render(view) {
    const customers = await api('/customers?include_inactive=1');
    view.innerHTML = `
      <div class="toolbar">
        <input type="date" id="fFrom" value="${monthStart()}"> <input type="date" id="fTo" value="${today()}">
        <select id="fCustomer"><option value="">Todos los clientes</option>${customers.map((c) => opt(c.id, c.name)).join('')}</select>
        <select id="fStatus"><option value="emitido">Emitidos</option><option value="anulado">Anulados</option><option value="">Todos</option></select>
        <span class="spacer"></span><a class="btn primary" href="#/ventas">📃 Emitir desde una venta</a>
      </div>
      <p class="muted" style="margin-top:0">Los remitos X se emiten desde una venta: en <b>Ventas</b> tocá <b>📃 Emitir remito</b>, o hacelo al confirmar la venta. Documento no válido como factura.</p>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="table">
        <thead><tr><th>N° remito</th><th>Fecha</th><th>Cliente</th><th>Dirección de entrega</th><th>Venta</th><th class="n">Total</th><th>Estado</th><th></th></tr></thead>
        <tbody id="rBody"></tbody></table></div></div>`;
    const load = safe(async () => {
      const qs = new URLSearchParams({ from: $('#fFrom').value, to: $('#fTo').value, customer_id: $('#fCustomer').value, status: $('#fStatus').value });
      const rows = await api('/remitos?' + qs);
      $('#rBody').innerHTML = rows.length
        ? rows
            .map(
              (r) => `<tr><td><b>${esc(r.code)}</b></td><td>${esc(r.date)}</td><td>${esc(r.customer_name || 'Consumidor final')}</td>
          <td>${esc(r.delivery_address || '')}</td><td>#${r.sale_id}</td><td class="n">${r.valued ? money(r.total) : '<span class="muted">sin precios</span>'}</td>
          <td>${r.status === 'emitido' ? '<span class="badge ok">Emitido</span>' : '<span class="badge danger">Anulado</span>'}</td>
          <td class="actions"><a class="btn sm" href="/api/remitos/${r.id}/pdf" download>⬇️ PDF</a>
            <a class="btn sm" href="/api/remitos/${r.id}/pdf?inline=1" target="_blank" title="Imprimir">🖨️</a>
            ${r.status === 'emitido' ? `<button class="btn sm danger" data-cancel="${r.id}">Anular</button>` : ''}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="8" class="empty">No hay remitos con esos filtros</td></tr>';
    });
    ['#fFrom', '#fTo', '#fCustomer', '#fStatus'].forEach((s) => ($(s).onchange = load));
    $('#rBody').onclick = safe(async (e) => {
      const id = e.target.dataset.cancel;
      if (id && (await confirmDialog('¿Anular este remito? La venta no se modifica; después podés emitir uno nuevo desde la venta.', 'Anular remito'))) {
        await api(`/remitos/${id}/cancel`, { method: 'POST' });
        toast('Remito anulado', 'ok');
        load();
      }
    });
    load();
  },
};

// ---------- Gráfico de barras (SVG, sin librerías) ----------
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const monthLabel = (ym, long) => {
  const [y, m] = ym.split('-').map(Number);
  const names = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return long ? `${names[m - 1]} ${y}` : `${MONTHS_ES[m - 1]} ${String(y).slice(2)}`;
};
const shortMoney = (n) => {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 })}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3).toLocaleString('es-AR')}k`;
  return `${sign}$${Math.round(a)}`;
};

/**
 * Barras agrupadas por categoría (mes). series: [{ name, color, values[] }]. Valores negativos van bajo la línea base.
 * Tooltip por grupo al pasar el mouse o con foco de teclado.
 */
function barChart(el, { categories, series, height = 240 }) {
  const width = Math.max(320, el.clientWidth || 600);
  const pad = { top: 12, right: 8, bottom: 26, left: 52 };
  const all = series.flatMap((s) => s.values);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const step = (() => {
    const raw = span / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw);
  })();
  const top = Math.ceil(max / step) * step;
  const bottom = Math.floor(min / step) * step;
  const plotH = height - pad.top - pad.bottom;
  const y = (v) => pad.top + ((top - v) / (top - bottom || 1)) * plotH;
  const groupW = (width - pad.left - pad.right) / categories.length;
  const gap = 2;
  const barW = Math.max(3, Math.min(28, (groupW * 0.7 - gap * (series.length - 1)) / series.length));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('role', 'img');
  const add = (tag, attrs, parent = svg) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.appendChild(e);
    return e;
  };
  for (let v = bottom; v <= top + 1e-9; v += step) {
    add('line', { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v), stroke: v === 0 ? '#9aa3b2' : '#e8ebf1', 'stroke-width': 1 });
    const t = add('text', { x: pad.left - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#6b7385' });
    t.textContent = shortMoney(v);
  }
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  categories.forEach((c, i) => {
    const gx = pad.left + i * groupW;
    const totalW = series.length * barW + (series.length - 1) * gap;
    const g = add('g', { tabindex: 0, class: 'chart-group' });
    add('rect', { x: gx, y: pad.top, width: groupW, height: plotH, fill: 'transparent', class: 'chart-hit' }, g);
    series.forEach((s, k) => {
      const v = s.values[i] || 0;
      const x = gx + (groupW - totalW) / 2 + k * (barW + gap);
      const y0 = y(Math.max(v, 0));
      const h = Math.max(v === 0 ? 0 : 1, Math.abs(y(v) - y(0)));
      add('rect', { x, y: v >= 0 ? y0 : y(0), width: barW, height: h, rx: Math.min(4, barW / 2), fill: s.color }, g);
    });
    const t = add('text', { x: gx + groupW / 2, y: height - 8, 'text-anchor': 'middle', 'font-size': 11, fill: '#6b7385' });
    t.textContent = c.label;
    const show = () => {
      tip.replaceChildren();
      const h = document.createElement('div');
      h.className = 'chart-tip-title';
      h.textContent = c.title || c.label;
      tip.appendChild(h);
      series.forEach((s) => {
        const row = document.createElement('div');
        row.className = 'chart-tip-row';
        const key = document.createElement('span');
        key.className = 'chart-key';
        key.style.background = s.color;
        const val = document.createElement('b');
        val.textContent = money(s.values[i] || 0);
        const name = document.createElement('span');
        name.className = 'muted';
        name.textContent = s.name;
        row.append(key, val, name);
        tip.appendChild(row);
      });
      tip.hidden = false;
      const left = Math.min(Math.max(0, ((gx + groupW / 2) / width) * el.clientWidth - 80), el.clientWidth - 170);
      tip.style.left = left + 'px';
      tip.style.top = '4px';
    };
    g.addEventListener('pointerenter', show);
    g.addEventListener('focus', show);
    g.addEventListener('pointerleave', () => (tip.hidden = true));
    g.addEventListener('blur', () => (tip.hidden = true));
  });
  el.replaceChildren(svg, tip);
  el.classList.add('chart');
  if (series.length > 1) {
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    series.forEach((s) => {
      const item = document.createElement('span');
      const key = document.createElement('span');
      key.className = 'chart-key';
      key.style.background = s.color;
      item.append(key, document.createTextNode(s.name));
      legend.appendChild(item);
    });
    el.prepend(legend);
  }
}

const CHART = { ventas: '#2f63c9', compras: '#d26600' };
const ymOf = (d) => d.toLocaleDateString('sv-SE').slice(0, 7);
const lastDay = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).toLocaleDateString('sv-SE');
};
const pct = (a, b) => (b ? Math.round(((a - b) / Math.abs(b)) * 100) : null);
const delta = (a, b) => {
  const p = pct(a, b);
  if (p === null) return '';
  return `<span class="${p >= 0 ? 'pos' : 'neg'}" style="font-size:12px">${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}%</span>`;
};

// ---------- Reportes: mes a mes y detalle de período ----------
views.reportes = {
  title: 'Reportes',
  async render(view) {
    const now = new Date();
    const st = (views.reportes.state ||= {
      from: ymOf(new Date(now.getFullYear(), now.getMonth() - 11, 1)),
      to: ymOf(now),
      pFrom: monthStart(),
      pTo: today(),
      tab: 'products',
    });
    view.innerHTML = `
      <div class="toolbar">
        <label class="muted">Desde</label><input type="month" id="mFrom" value="${st.from}">
        <label class="muted">Hasta</label><input type="month" id="mTo" value="${st.to}">
        <button class="btn sm" data-range="12">Últimos 12 meses</button>
        <button class="btn sm" data-range="year">Este año</button>
        <button class="btn sm" data-range="lastyear">Año anterior</button>
        <span class="spacer"></span>
        <a class="btn" id="mXlsx">📊 Excel</a>
      </div>
      <div class="grid cols-4" id="mStats"></div>
      <div class="grid cols-2" style="margin-top:16px">
        <div class="card"><h2>Ventas y compras por mes</h2><div id="chartSales"></div></div>
        <div class="card"><h2>Ganancia neta por mes</h2><p class="muted" style="margin:-6px 0 6px;font-size:12px">Ventas − costo de lo vendido − gastos</p><div id="chartProfit"></div></div>
      </div>
      <div class="card" style="padding:0"><h2 style="padding:16px 16px 0">Comparativo mes a mes <span class="muted" style="font-weight:400;font-size:12px">— tocá un mes para ver el detalle</span></h2>
        <div class="table-wrap"><table class="table"><thead><tr>
          <th>Mes</th><th class="n">Ventas</th><th class="n">vs mes ant.</th><th class="n">Cant.</th><th class="n">Ticket prom.</th><th class="n">Costo vendido</th>
          <th class="n">Ganancia bruta</th><th class="n">Margen</th><th class="n">Gastos</th><th class="n">Ganancia neta</th><th class="n">Compras</th></tr></thead>
          <tbody id="mBody"></tbody><tfoot id="mFoot"></tfoot></table></div></div>
      <div class="card" id="periodCard">
        <h2>🔎 Detalle del período</h2>
        <div class="toolbar">
          <input type="date" id="pFrom" value="${st.pFrom}"> <input type="date" id="pTo" value="${st.pTo}">
          <span class="spacer"></span><a class="btn sm" id="pHistory">Ver operaciones en el Historial →</a>
        </div>
        <div class="grid cols-4" id="pStats"></div>
        <div class="tabs" id="pTabs" style="margin-top:12px">
          ${[['products', 'Productos vendidos'], ['categories', 'Por categoría'], ['customers', 'Clientes'], ['suppliers', 'Compras por proveedor'], ['purchased', 'Productos comprados'], ['expenses', 'Gastos']]
            .map(([k, l]) => `<button data-tab="${k}" class="${st.tab === k ? 'active' : ''}">${l}</button>`)
            .join('')}
        </div>
        <div class="table-wrap" id="pBody"></div>
      </div>`;

    let months = [];
    const loadMonthly = safe(async () => {
      const d = await api(`/reports/monthly?from_month=${st.from}&to_month=${st.to}`);
      months = d.months;
      $('#mXlsx').href = `/api/reports/monthly.xlsx?from_month=${st.from}&to_month=${st.to}`;
      const sum = (k) => months.reduce((a, m) => a + m[k], 0);
      const ventas = sum('ventas');
      const bruta = sum('ganancia_bruta');
      $('#mStats').innerHTML = `
        <div class="stat"><div class="label">Ventas del período</div><div class="value">${money(ventas)}</div><div class="sub">${sum('ventas_count')} ventas · ${qty(sum('unidades'))} unidades</div></div>
        <div class="stat ok"><div class="label">Ganancia bruta</div><div class="value">${money(bruta)}</div><div class="sub">Margen ${ventas ? Math.round((bruta / ventas) * 100) : 0}%</div></div>
        <div class="stat ${sum('ganancia_neta') < 0 ? 'danger' : 'ok'}"><div class="label">Ganancia neta</div><div class="value">${money(sum('ganancia_neta'))}</div><div class="sub">Gastos: ${money(sum('gastos'))}</div></div>
        <div class="stat"><div class="label">Compras del período</div><div class="value">${money(sum('compras'))}</div><div class="sub">${sum('compras_count')} compras</div></div>`;
      const cats = months.map((m) => ({ label: monthLabel(m.month), title: monthLabel(m.month, true) }));
      barChart($('#chartSales'), {
        categories: cats,
        series: [
          { name: 'Ventas', color: CHART.ventas, values: months.map((m) => m.ventas) },
          { name: 'Compras', color: CHART.compras, values: months.map((m) => m.compras) },
        ],
      });
      barChart($('#chartProfit'), { categories: cats, series: [{ name: 'Ganancia neta', color: CHART.ventas, values: months.map((m) => m.ganancia_neta) }] });
      $('#mBody').innerHTML = months
        .map(
          (m, i) => `<tr data-month="${m.month}" style="cursor:pointer"><td><b>${monthLabel(m.month, true)}</b></td>
          <td class="n"><b>${money(m.ventas)}</b></td><td class="n">${i ? delta(m.ventas, months[i - 1].ventas) : ''}</td><td class="n">${m.ventas_count}</td>
          <td class="n">${money(m.ticket_promedio)}</td><td class="n">${money(m.costo)}</td><td class="n">${money(m.ganancia_bruta)}</td>
          <td class="n">${m.margen}%</td><td class="n">${money(m.gastos)}</td><td class="n"><b class="${m.ganancia_neta < 0 ? 'neg' : ''}">${money(m.ganancia_neta)}</b></td>
          <td class="n">${money(m.compras)}</td></tr>`
        )
        .reverse()
        .join('');
      $('#mFoot').innerHTML = `<tr style="font-weight:700"><td>Total</td><td class="n">${money(ventas)}</td><td></td><td class="n">${sum('ventas_count')}</td><td></td>
        <td class="n">${money(sum('costo'))}</td><td class="n">${money(bruta)}</td><td class="n">${ventas ? Math.round((bruta / ventas) * 100) : 0}%</td>
        <td class="n">${money(sum('gastos'))}</td><td class="n">${money(sum('ganancia_neta'))}</td><td class="n">${money(sum('compras'))}</td></tr>`;
    });

    const TABLES = {
      products: { cols: [['Producto', 'name'], ['Categoría', 'category'], ['Cantidad', 'qty', 'q'], ['Vendido', 'total', '$'], ['Costo', 'cost', '$'], ['Ganancia', 'profit', '$']] },
      categories: { cols: [['Categoría', 'name'], ['Unidades', 'qty', 'q'], ['Vendido', 'total', '$'], ['Ganancia', 'profit', '$']] },
      customers: { cols: [['Cliente', 'name'], ['Ventas', 'n', 'q'], ['Total', 'total', '$'], ['Ganancia', 'profit', '$']] },
      suppliers: { cols: [['Proveedor', 'name'], ['Compras', 'n', 'q'], ['Total', 'total', '$']] },
      purchased: { cols: [['Producto', 'name'], ['Cantidad', 'qty', 'q'], ['Costo promedio', 'avg_cost', '$'], ['Total', 'total', '$']] },
      expenses: { cols: [['Concepto', 'name'], ['Veces', 'n', 'q'], ['Total', 'total', '$']] },
    };
    let detail = null;
    const renderTab = () => {
      const t = TABLES[st.tab];
      const rows = detail[st.tab];
      $$('#pTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === st.tab));
      const cell = (r, [, k, f]) => `<td class="${f ? 'n' : ''}">${f === '$' ? money(r[k]) : f === 'q' ? qty(r[k] || 0) : esc(r[k] || '')}</td>`;
      $('#pBody').innerHTML = rows.length
        ? `<table class="table"><thead><tr>${t.cols.map(([l, , f]) => `<th class="${f ? 'n' : ''}">${l}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r) => `<tr>${t.cols.map((c) => cell(r, c)).join('')}</tr>`).join('')}</tbody></table>`
        : '<div class="empty">Sin datos en este período</div>';
    };
    const loadPeriod = safe(async () => {
      detail = await api(`/reports/period?from=${st.pFrom}&to=${st.pTo}`);
      const sumOf = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
      const ventas = sumOf(detail.customers, 'total');
      const ganancia = sumOf(detail.customers, 'profit');
      const gastos = sumOf(detail.expenses, 'total');
      $('#pStats').innerHTML = `
        <div class="stat"><div class="label">Vendido</div><div class="value">${money(ventas)}</div><div class="sub">${sumOf(detail.customers, 'n')} ventas</div></div>
        <div class="stat ok"><div class="label">Ganancia bruta</div><div class="value">${money(ganancia)}</div></div>
        <div class="stat"><div class="label">Gastos</div><div class="value">${money(gastos)}</div></div>
        <div class="stat"><div class="label">Comprado</div><div class="value">${money(sumOf(detail.suppliers, 'total'))}</div><div class="sub">${sumOf(detail.suppliers, 'n')} compras</div></div>`;
      $('#pHistory').href = `#/historial?from=${st.pFrom}&to=${st.pTo}`;
      renderTab();
    });

    $('#mFrom').onchange = (e) => { st.from = e.target.value; loadMonthly(); };
    $('#mTo').onchange = (e) => { st.to = e.target.value; loadMonthly(); };
    $$('[data-range]', view).forEach(
      (b) =>
        (b.onclick = () => {
          const y = now.getFullYear();
          if (b.dataset.range === '12') [st.from, st.to] = [ymOf(new Date(y, now.getMonth() - 11, 1)), ymOf(now)];
          if (b.dataset.range === 'year') [st.from, st.to] = [`${y}-01`, ymOf(now)];
          if (b.dataset.range === 'lastyear') [st.from, st.to] = [`${y - 1}-01`, `${y - 1}-12`];
          $('#mFrom').value = st.from;
          $('#mTo').value = st.to;
          loadMonthly();
        })
    );
    $('#mBody').onclick = (e) => {
      const tr = e.target.closest('[data-month]');
      if (!tr) return;
      st.pFrom = tr.dataset.month + '-01';
      st.pTo = lastDay(tr.dataset.month);
      $('#pFrom').value = st.pFrom;
      $('#pTo').value = st.pTo;
      loadPeriod();
      $('#periodCard').scrollIntoView({ behavior: 'smooth' });
    };
    $('#pFrom').onchange = (e) => { st.pFrom = e.target.value; loadPeriod(); };
    $('#pTo').onchange = (e) => { st.pTo = e.target.value; loadPeriod(); };
    $('#pTabs').onclick = (e) => {
      if (!e.target.dataset.tab) return;
      st.tab = e.target.dataset.tab;
      renderTab();
    };
    await Promise.all([loadMonthly(), loadPeriod()]);
  },
};

// ---------- Historial de operaciones ----------
const KIND_INFO = {
  venta: ['Venta', 'ok'],
  compra: ['Compra', 'warn'],
  cobro: ['Cobro', 'ok'],
  pago: ['Pago a proveedor', 'warn'],
  gasto: ['Gasto', 'danger'],
  ingreso: ['Ingreso', 'ok'],
  traspaso: ['Traspaso', ''],
  presupuesto: ['Presupuesto', 'info'],
  remito: ['Remito', 'info'],
  ajuste_stock: ['Ajuste stock', ''],
  ajuste_cc: ['Ajuste CC', ''],
};

views.historial = {
  title: 'Historial de operaciones',
  async render(view) {
    const qs = new URLSearchParams(location.hash.split('?')[1] || '');
    const [customers, suppliers] = await Promise.all([api('/customers?include_inactive=1'), api('/suppliers?include_inactive=1')]);
    const st = {
      from: qs.get('from') || monthStart(),
      to: qs.get('to') || today(),
      kind: qs.get('kind') || '',
      customer_id: qs.get('customer_id') || '',
      supplier_id: qs.get('supplier_id') || '',
      status: 'activas',
      q: '',
    };
    view.innerHTML = `
      <div class="card">
        <div class="toolbar" style="margin-bottom:8px">
          <label class="muted">Mes</label><input type="month" id="hMonth" value="${st.from.slice(0, 7)}">
          <label class="muted">o desde</label><input type="date" id="hFrom" value="${st.from}"><label class="muted">hasta</label><input type="date" id="hTo" value="${st.to}">
          <button class="btn sm" data-quick="hoy">Hoy</button><button class="btn sm" data-quick="mes">Este mes</button>
          <button class="btn sm" data-quick="ant">Mes anterior</button><button class="btn sm" data-quick="anio">Este año</button>
        </div>
        <div class="toolbar" style="margin:0">
          <select id="hKind"><option value="">Todas las operaciones</option>
            ${Object.entries(KIND_INFO).map(([k, [l]]) => opt(k, l, st.kind)).join('')}
            <option value="venta,cobro,ingreso" ${st.kind === 'venta,cobro,ingreso' ? 'selected' : ''}>Todo lo que entra</option>
            <option value="compra,pago,gasto" ${st.kind === 'compra,pago,gasto' ? 'selected' : ''}>Todo lo que sale</option></select>
          <select id="hCustomer"><option value="">Cualquier cliente</option>${customers.map((c) => opt(c.id, c.name, st.customer_id)).join('')}</select>
          <select id="hSupplier"><option value="">Cualquier proveedor</option>${suppliers.map((c) => opt(c.id, c.name, st.supplier_id)).join('')}</select>
          <select id="hStatus"><option value="activas">Sin anuladas</option><option value="anuladas">Solo anuladas</option><option value="">Todas</option></select>
          <input id="hQ" placeholder="Buscar texto (concepto, factura, nombre)" style="min-width:220px">
          <span class="spacer"></span><a class="btn" id="hXlsx">📊 Excel</a>
        </div>
      </div>
      <div class="grid cols-4" id="hStats"></div>
      <div class="card" style="padding:0;margin-top:16px"><div class="table-wrap"><table class="table">
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Operación</th><th>Cliente / Proveedor</th><th class="n">Importe</th><th>Caja</th><th>Estado</th><th></th></tr></thead>
        <tbody id="hBody"></tbody></table></div></div>
      <p class="muted" id="hNote"></p>`;

    const docLink = (r) => {
      if (r.kind === 'venta') return `<a class="btn sm" href="/api/sales/${r.id}/pdf" download>PDF</a>`;
      if (r.kind === 'presupuesto') return `<a class="btn sm" href="/api/quotes/${r.id}/pdf" download>PDF</a>`;
      if (r.kind === 'remito') return `<a class="btn sm" href="/api/remitos/${r.id}/pdf" download>PDF</a>`;
      return '';
    };
    const load = safe(async () => {
      const params = new URLSearchParams({ from: st.from, to: st.to, kind: st.kind, customer_id: st.customer_id, supplier_id: st.supplier_id, status: st.status, q: st.q });
      $('#hXlsx').href = '/api/history.xlsx?' + params;
      const d = await api('/history?' + params);
      const S = d.summary;
      const tile = (k, label, cls = '') =>
        `<div class="stat ${cls}"><div class="label">${label}</div><div class="value">${money(S[k] ? S[k].total : 0)}</div><div class="sub">${S[k] ? S[k].count : 0} operaciones</div></div>`;
      $('#hStats').innerHTML = tile('venta', 'Ventas', 'ok') + tile('compra', 'Compras') + tile('cobro', 'Cobros de cuenta corriente') + tile('gasto', 'Gastos', 'danger');
      const isVoid = (r) => r.status === 'anulada' || r.status === 'anulado';
      $('#hBody').innerHTML = d.rows.length
        ? d.rows
            .map((r) => {
              const [label, cls] = KIND_INFO[r.kind] || [r.kind, ''];
              const amount = r.kind === 'ajuste_stock' ? `${r.amount > 0 ? '+' : ''}${qty(r.amount)} u.` : money(r.amount);
              return `<tr style="${isVoid(r) ? 'opacity:.55' : ''}"><td style="white-space:nowrap">${esc(r.date)}</td><td><span class="badge ${cls}">${label}</span></td>
                <td>${esc(r.label)}${r.detail ? `<div class="muted" style="font-size:12px">${esc(r.detail)}</div>` : ''}</td><td>${esc(r.party || '')}</td>
                <td class="n"><b>${amount}</b></td><td>${esc(r.box || '')}</td><td>${isVoid(r) ? '<span class="badge danger">Anulada</span>' : ''}</td>
                <td class="actions">${docLink(r)}</td></tr>`;
            })
            .join('')
        : '<tr><td colspan="8" class="empty">No hay operaciones con esos filtros</td></tr>';
      $('#hNote').textContent = d.truncated ? 'Se muestran las primeras 1000 operaciones. Acotá el período o descargá el Excel para ver todo.' : `${d.rows.length} operaciones`;
    });
    const setRange = (from, to) => {
      st.from = from;
      st.to = to;
      $('#hFrom').value = from;
      $('#hTo').value = to;
      $('#hMonth').value = from.slice(0, 7);
      load();
    };
    $('#hMonth').onchange = (e) => e.target.value && setRange(e.target.value + '-01', lastDay(e.target.value));
    $('#hFrom').onchange = (e) => { st.from = e.target.value; load(); };
    $('#hTo').onchange = (e) => { st.to = e.target.value; load(); };
    $$('[data-quick]', view).forEach(
      (b) =>
        (b.onclick = () => {
          const n = new Date();
          if (b.dataset.quick === 'hoy') setRange(today(), today());
          if (b.dataset.quick === 'mes') setRange(monthStart(), today());
          if (b.dataset.quick === 'ant') {
            const m = ymOf(new Date(n.getFullYear(), n.getMonth() - 1, 1));
            setRange(m + '-01', lastDay(m));
          }
          if (b.dataset.quick === 'anio') setRange(`${n.getFullYear()}-01-01`, today());
        })
    );
    $('#hKind').onchange = (e) => { st.kind = e.target.value; load(); };
    $('#hCustomer').onchange = (e) => { st.customer_id = e.target.value; load(); };
    $('#hSupplier').onchange = (e) => { st.supplier_id = e.target.value; load(); };
    $('#hStatus').onchange = (e) => { st.status = e.target.value; load(); };
    $('#hQ').oninput = debounce((e) => { st.q = e.target.value; load(); }, 300);
    load();
  },
};

// ---------- Comprar ----------
const buy = { items: [], supplier_id: '', invoice_number: '', date: '', paid_cash: '', paid_transfer: '', notes: '', update_cost: true };

views.comprar = {
  title: 'Nueva compra',
  async render(view) {
    const suppliers = await api('/suppliers');
    view.innerHTML = `
      <div class="pos-layout">
        <div>
          <div class="card"><div class="field"><input id="buySearch" class="big" placeholder="🔍 Escaneá o buscá el producto a ingresar" autocomplete="off"></div>
            <div class="muted" style="margin-top:6px">¿Producto nuevo? <a href="#" id="buyNewProduct">Crealo acá</a></div></div>
          <div class="card" style="padding:0"><div class="table-wrap"><table class="table">
            <thead><tr><th>Producto</th><th class="n">Stock actual</th><th class="n">Cantidad</th><th class="n">Costo unit.</th><th class="n">Subtotal</th><th></th></tr></thead>
            <tbody id="buyBody"></tbody></table></div></div>
        </div>
        <div>
          <div class="card">
            ${field('Proveedor', `<select id="buySupplier"><option value="">— Sin proveedor —</option>${suppliers.map((s) => opt(s.id, s.name, buy.supplier_id)).join('')}</select>`)}
            <div id="supplierInfo" class="muted" style="margin:6px 0 10px"></div>
            <div class="pay-grid">
              ${field('N° factura / remito', `<input id="buyInvoice" value="${esc(buy.invoice_number)}">`)}
              ${field('Fecha', `<input type="date" id="buyDate" value="${buy.date || today()}">`)}
            </div>
            <label class="check" style="margin-top:10px"><input type="checkbox" id="buyUpdateCost" ${buy.update_cost ? 'checked' : ''}> Actualizar costo de los productos</label>
          </div>
          <div class="card">
            <div class="total-box" id="buyTotal"></div>
            <div class="toolbar" style="margin:8px 0">
              <button class="btn sm" data-fill="efectivo">Todo efectivo</button>
              <button class="btn sm" data-fill="transferencia">Todo transferencia</button>
              <button class="btn sm" data-fill="cc">Todo a cuenta</button>
            </div>
            <div class="pay-grid">
              ${field('💵 Pago efectivo', `<input id="buyCash" value="${buy.paid_cash}" placeholder="0">`)}
              ${field('🏦 Pago transferencia', `<input id="buyTransfer" value="${buy.paid_transfer}" placeholder="0">`)}
            </div>
            <div id="buyPayInfo" style="margin:10px 0"></div>
            ${field('Notas', `<input id="buyNotes" value="${esc(buy.notes)}">`)}
            <div class="toolbar" style="margin-top:12px"><button class="btn" id="buyClear">Vaciar</button><span class="spacer"></span>
              <button class="btn ok lg" id="buyConfirm">✔ Registrar compra</button></div>
          </div>
        </div>
      </div>`;
    const total = () => round2(buy.items.reduce((a, i) => a + i.quantity * i.unit_cost, 0));
    const renderTotals = () => {
      const t = total();
      $('#buyTotal').textContent = money(t);
      const rest = round2(t - num(buy.paid_cash) - num(buy.paid_transfer));
      let html = '';
      if (rest > 0.004) html = `<div class="badge warn" style="font-size:13px">Queda a cuenta corriente: ${money(rest)}</div>`;
      if (rest < -0.004) html = '<div class="neg">Lo pagado supera el total</div>';
      if (rest > 0.004 && !buy.supplier_id) html += '<div class="neg" style="margin-top:6px">Elegí un proveedor para dejar saldo en cuenta corriente</div>';
      $('#buyPayInfo').innerHTML = html;
    };
    const renderItems = () => {
      $('#buyBody').innerHTML = buy.items.length
        ? buy.items
            .map(
              (i, idx) => `<tr><td><b>${esc(i.name)}</b>${i.units_per_pack > 1 ? `<br><button class="btn sm" data-pack="${idx}">+ bulto x${i.units_per_pack}</button>` : ''}</td>
          <td class="n muted">${qty(i.stock)}</td>
          <td class="n"><input class="cart-qty" data-qty="${idx}" value="${i.quantity}"></td>
          <td class="n"><input class="cart-price" data-cost="${idx}" value="${i.unit_cost}"></td>
          <td class="n"><b>${money(i.quantity * i.unit_cost)}</b></td>
          <td><button class="btn sm danger" data-del="${idx}">✕</button></td></tr>`
            )
            .join('')
        : '<tr><td colspan="6" class="empty">Agregá los productos que ingresan</td></tr>';
      renderTotals();
    };
    const renderSupplier = () => {
      const s = suppliers.find((x) => String(x.id) === String(buy.supplier_id));
      $('#supplierInfo').innerHTML = s ? `Saldo que le debemos: ${signed(s.balance)}` : '';
    };
    const addItem = (p) => {
      const ex = buy.items.find((i) => i.product_id === p.id);
      if (ex) ex.quantity += 1;
      else buy.items.push({ product_id: p.id, name: p.name, quantity: 1, unit_cost: p.cost, stock: p.stock, units_per_pack: p.units_per_pack });
      renderItems();
    };
    productPicker($('#buySearch'), { listId: () => '', onPick: addItem });
    $('#buyNewProduct').onclick = (e) => {
      e.preventDefault();
      productForm(null, async (id) => addItem(await api('/products/' + id)));
    };
    $('#buyBody').addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.qty !== undefined) {
        const q = num(t.value);
        if (q <= 0) buy.items.splice(Number(t.dataset.qty), 1);
        else buy.items[t.dataset.qty].quantity = q;
      }
      if (t.dataset.cost !== undefined) buy.items[t.dataset.cost].unit_cost = round2(num(t.value));
      renderItems();
    });
    $('#buyBody').addEventListener('click', (e) => {
      const t = e.target;
      if (t.dataset.del !== undefined) buy.items.splice(Number(t.dataset.del), 1);
      else if (t.dataset.pack !== undefined) buy.items[t.dataset.pack].quantity += buy.items[t.dataset.pack].units_per_pack;
      else return;
      renderItems();
    });
    $('#buySupplier').onchange = (e) => {
      buy.supplier_id = e.target.value;
      renderSupplier();
      renderTotals();
    };
    $('#buyInvoice').oninput = (e) => (buy.invoice_number = e.target.value);
    $('#buyDate').onchange = (e) => (buy.date = e.target.value);
    $('#buyNotes').oninput = (e) => (buy.notes = e.target.value);
    $('#buyUpdateCost').onchange = (e) => (buy.update_cost = e.target.checked);
    $('#buyCash').oninput = (e) => { buy.paid_cash = e.target.value; renderTotals(); };
    $('#buyTransfer').oninput = (e) => { buy.paid_transfer = e.target.value; renderTotals(); };
    $$('[data-fill]', view).forEach(
      (b) =>
        (b.onclick = () => {
          buy.paid_cash = b.dataset.fill === 'efectivo' ? String(total()) : '';
          buy.paid_transfer = b.dataset.fill === 'transferencia' ? String(total()) : '';
          $('#buyCash').value = buy.paid_cash;
          $('#buyTransfer').value = buy.paid_transfer;
          renderTotals();
        })
    );
    const reset = () => Object.assign(buy, { items: [], supplier_id: '', invoice_number: '', date: '', paid_cash: '', paid_transfer: '', notes: '', update_cost: true });
    $('#buyClear').onclick = () => { reset(); views.comprar.render(view); };
    $('#buyConfirm').onclick = safe(async () => {
      if (!buy.items.length) throw new Error('Agregá productos a la compra');
      const date = buy.date && buy.date !== today() ? buy.date + ' 12:00:00' : null;
      const r = await api('/purchases', {
        method: 'POST',
        body: {
          supplier_id: buy.supplier_id || null,
          invoice_number: buy.invoice_number,
          date,
          items: buy.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, unit_cost: i.unit_cost })),
          paid_cash: num(buy.paid_cash),
          paid_transfer: num(buy.paid_transfer),
          notes: buy.notes,
          update_cost: buy.update_cost,
        },
      });
      toast(`Compra #${r.id} registrada por ${money(r.total)}. Stock actualizado.`, 'ok');
      reset();
      refreshTopBalances();
      views.comprar.render(view);
    });
    renderSupplier();
    renderItems();
    $('#buySearch').focus();
  },
};

// ---------- Historial de compras ----------
views.compras = {
  title: 'Compras',
  async render(view) {
    const suppliers = await api('/suppliers?include_inactive=1');
    view.innerHTML = `
      <div class="toolbar">
        <input type="date" id="fFrom" value="${monthStart()}"> <input type="date" id="fTo" value="${today()}">
        <select id="fSupplier"><option value="">Todos los proveedores</option>${suppliers.map((c) => opt(c.id, c.name)).join('')}</select>
        <span class="spacer"></span><a class="btn primary" href="#/comprar">📦 Nueva compra</a>
      </div>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Fecha</th><th>Proveedor</th><th>Factura</th><th class="n">Total</th><th class="n">Efectivo</th><th class="n">Transf.</th><th class="n">A cuenta</th><th>Estado</th><th></th></tr></thead>
        <tbody id="purBody"></tbody></table></div></div>`;
    const load = safe(async () => {
      const q = new URLSearchParams({ from: $('#fFrom').value, to: $('#fTo').value, supplier_id: $('#fSupplier').value });
      const rows = await api('/purchases?' + q);
      $('#purBody').innerHTML = rows.length
        ? rows
            .map(
              (p) => `<tr><td>${p.id}</td><td>${esc(p.date)}</td><td>${esc(p.supplier_name || '—')}</td><td>${esc(p.invoice_number || '')}</td>
          <td class="n"><b>${money(p.total)}</b></td><td class="n">${money(p.paid_cash)}</td><td class="n">${money(p.paid_transfer)}</td><td class="n">${money(p.on_account)}</td>
          <td>${p.status === 'ok' ? '<span class="badge ok">OK</span>' : '<span class="badge danger">Anulada</span>'}</td>
          <td class="actions"><button class="btn sm" data-view="${p.id}">Ver</button>
          ${p.status === 'ok' ? `<button class="btn sm danger" data-cancel="${p.id}">Anular</button>` : ''}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="10" class="empty">No hay compras en el período</td></tr>';
    });
    ['#fFrom', '#fTo', '#fSupplier'].forEach((s) => ($(s).onchange = load));
    $('#purBody').onclick = safe(async (e) => {
      if (e.target.dataset.view) {
        const p = await api('/purchases/' + e.target.dataset.view);
        modal({
          title: `Compra #${p.id} — ${p.date}`,
          wide: true,
          body: `<p><b>Proveedor:</b> ${esc(p.supplier_name || '—')} ${p.invoice_number ? `· <b>Factura:</b> ${esc(p.invoice_number)}` : ''}</p>
            <table class="table"><thead><tr><th>Producto</th><th class="n">Cant.</th><th class="n">Costo unit.</th><th class="n">Subtotal</th></tr></thead>
            <tbody>${p.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="n">${qty(i.quantity)}</td><td class="n">${money(i.unit_cost)}</td><td class="n">${money(i.subtotal)}</td></tr>`).join('')}</tbody></table>
            <p style="text-align:right"><b>Total: ${money(p.total)}</b></p>${p.notes ? `<p>${esc(p.notes)}</p>` : ''}`,
          actions: [{ label: 'Cerrar', cls: 'primary' }],
        });
      }
      const cid = e.target.dataset.cancel;
      if (cid && (await confirmDialog(`¿Anular la compra #${cid}? Se descuenta el stock ingresado y se revierten caja y cuenta corriente.`, 'Anular compra'))) {
        await api(`/purchases/${cid}/cancel`, { method: 'POST' });
        toast('Compra anulada', 'ok');
        refreshTopBalances();
        load();
      }
    });
    load();
  },
};

// ---------- Caja ----------
views.caja = {
  title: 'Caja',
  async render(view) {
    view.innerHTML = `
      <div class="grid cols-3" id="boxStats"></div>
      <div class="toolbar" style="margin-top:16px">
        <button class="btn primary" data-mov="ingreso">➕ Ingreso</button>
        <button class="btn" data-mov="egreso">➖ Egreso / gasto</button>
        <button class="btn" id="boxTransfer">🔁 Traspaso entre cajas</button>
        <span class="spacer"></span>
        <select id="fBox"><option value="">Ambas cajas</option><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select>
        <input type="date" id="fFrom" value="${monthStart()}"> <input type="date" id="fTo" value="${today()}">
      </div>
      <div id="periodStats" class="muted" style="margin-bottom:8px"></div>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="table">
        <thead><tr><th>Fecha</th><th>Caja</th><th>Concepto</th><th>Origen</th><th class="n">Ingreso</th><th class="n">Egreso</th><th></th></tr></thead>
        <tbody id="cashBody"></tbody></table></div></div>`;
    const load = safe(async () => {
      const q = new URLSearchParams({ box: $('#fBox').value, from: $('#fFrom').value, to: $('#fTo').value });
      const d = await api('/cash?' + q);
      $('#boxStats').innerHTML = `
        <div class="stat"><div class="label">💵 Caja efectivo</div><div class="value">${money(d.balances.efectivo)}</div></div>
        <div class="stat"><div class="label">🏦 Caja transferencia / banco</div><div class="value">${money(d.balances.transferencia)}</div></div>
        <div class="stat ok"><div class="label">Total disponible</div><div class="value">${money(d.balances.total)}</div></div>`;
      $('#periodStats').innerHTML = `Período: ingresos <b class="pos">${money(d.period.ingresos)}</b> · egresos <b class="neg">${money(d.period.egresos)}</b> · neto <b>${money(d.period.ingresos - d.period.egresos)}</b>`;
      $('#cashBody').innerHTML = d.movements.length
        ? d.movements
            .map(
              (m) => `<tr><td>${esc(m.date)}</td><td><span class="badge ${m.box === 'efectivo' ? 'ok' : 'info'}">${m.box}</span></td><td>${esc(m.concept)}</td>
          <td class="muted">${esc(m.ref_type || '')}</td>
          <td class="n pos">${m.amount > 0 ? money(m.amount) : ''}</td><td class="n neg">${m.amount < 0 ? money(-m.amount) : ''}</td>
          <td class="actions">${m.ref_type === 'manual' ? `<button class="btn sm danger" data-del="${m.id}">✕</button>` : ''}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="7" class="empty">Sin movimientos</td></tr>';
      refreshTopBalances();
    });
    ['#fBox', '#fFrom', '#fTo'].forEach((s) => ($(s).onchange = load));
    $$('[data-mov]', view).forEach(
      (b) =>
        (b.onclick = () => {
          const type = b.dataset.mov;
          modal({
            title: type === 'ingreso' ? 'Registrar ingreso' : 'Registrar egreso / gasto',
            body: `<div class="form-grid">
              ${field('Caja', '<select name="box"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select>')}
              ${field('Importe', '<input name="amount" inputmode="decimal">')}
              ${field('Concepto', `<input name="concept" placeholder="${type === 'ingreso' ? 'Ej: Saldo inicial, aporte' : 'Ej: Flete, luz, sueldo, retiro'}">`, 'full')}</div>`,
            actions: [
              { label: 'Cancelar' },
              {
                label: 'Guardar',
                cls: 'primary',
                onClick: async (el) => {
                  const f = formData(el);
                  await api('/cash/movements', { method: 'POST', body: { ...f, amount: num(f.amount), type } });
                  toast('Movimiento registrado', 'ok');
                  load();
                },
              },
            ],
          });
        })
    );
    $('#boxTransfer').onclick = () =>
      modal({
        title: 'Traspaso entre cajas',
        body: `<div class="form-grid">
          ${field('Desde', '<select name="from"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select>')}
          ${field('Hacia', '<select name="to"><option value="transferencia">Transferencia</option><option value="efectivo">Efectivo</option></select>')}
          ${field('Importe', '<input name="amount" inputmode="decimal">')}
          ${field('Concepto', '<input name="concept" placeholder="Ej: Depósito en banco">')}</div>`,
        actions: [
          { label: 'Cancelar' },
          {
            label: 'Traspasar',
            cls: 'primary',
            onClick: async (el) => {
              const f = formData(el);
              await api('/cash/transfer', { method: 'POST', body: { ...f, amount: num(f.amount) } });
              toast('Traspaso realizado', 'ok');
              load();
            },
          },
        ],
      });
    $('#cashBody').onclick = safe(async (e) => {
      const id = e.target.dataset.del;
      if (id && (await confirmDialog('¿Eliminar este movimiento manual?', 'Eliminar'))) {
        await api('/cash/movements/' + id, { method: 'DELETE' });
        load();
      }
    });
    load();
  },
};

// ---------- Clientes y proveedores ----------
function partyViews({ key, endpoint, singular, plural, isCustomer }) {
  const form = async (party, onSaved) => {
    const lists = isCustomer ? await cache.lists() : [];
    const p = party || {};
    modal({
      title: party ? `Editar ${singular.toLowerCase()}` : `Nuevo ${singular.toLowerCase()}`,
      body: `<div class="form-grid">
        ${field('Nombre / Razón social *', `<input name="name" value="${esc(p.name)}">`, 'full')}
        ${field('CUIT / DNI', `<input name="tax_id" value="${esc(p.tax_id)}">`)}
        ${field('Teléfono', `<input name="phone" value="${esc(p.phone)}">`)}
        ${field('Email', `<input name="email" type="email" value="${esc(p.email)}">`)}
        ${field('Dirección', `<input name="address" value="${esc(p.address)}">`)}
        ${isCustomer ? field('Lista de precios', `<select name="price_list_id"><option value="">(la predeterminada)</option>${lists.map((l) => opt(l.id, l.name, p.price_list_id)).join('')}</select>`) : ''}
        ${isCustomer ? field('Límite de crédito (0 = sin límite)', `<input name="credit_limit" value="${p.credit_limit || ''}">`) : ''}
        ${!party ? field(isCustomer ? 'Saldo inicial que nos debe' : 'Saldo inicial que le debemos', '<input name="opening_balance" placeholder="0">') : ''}
        ${field('Notas', `<textarea name="notes" rows="2">${esc(p.notes)}</textarea>`, 'full')}</div>`,
      actions: [
        { label: 'Cancelar' },
        {
          label: 'Guardar',
          cls: 'primary',
          onClick: async (el) => {
            const f = formData(el);
            if (f.credit_limit !== undefined) f.credit_limit = num(f.credit_limit);
            if (f.opening_balance !== undefined) f.opening_balance = num(f.opening_balance);
            const r = party ? await api(`/${endpoint}/${party.id}`, { method: 'PUT', body: f }) : await api(`/${endpoint}`, { method: 'POST', body: f });
            toast(`${singular} guardado`, 'ok');
            onSaved && onSaved(party ? party.id : r.id);
          },
        },
      ],
    });
  };

  const paymentForm = (party, onSaved) =>
    modal({
      title: `${isCustomer ? 'Registrar cobro' : 'Registrar pago'} — ${party.name}`,
      body: `<p>Saldo actual: <b>${money(party.balance)}</b></p>
        <div class="form-grid">
        ${field('Tipo', `<select name="kind"><option value="pago">${isCustomer ? 'Cobro (entra dinero)' : 'Pago (sale dinero)'}</option>
          <option value="ajuste_haber">Ajuste: reducir deuda (nota de crédito)</option><option value="ajuste_debe">Ajuste: aumentar deuda (nota de débito)</option></select>`)}
        ${field('Caja', '<select name="box"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select>')}
        ${field('Importe', `<input name="amount" inputmode="decimal" value="${party.balance > 0 ? party.balance : ''}">`)}
        ${field('Concepto', '<input name="concept" placeholder="Opcional">')}</div>`,
      actions: [
        { label: 'Cancelar' },
        {
          label: 'Registrar',
          cls: 'primary',
          onClick: async (el) => {
            const f = formData(el);
            const r = await api(`/${endpoint}/${party.id}/payments`, { method: 'POST', body: { ...f, amount: num(f.amount) } });
            toast(`Registrado. Nuevo saldo: ${money(r.balance)}`, 'ok');
            refreshTopBalances();
            onSaved && onSaved();
          },
        },
      ],
    });

  views[key] = {
    title: plural,
    async render(view, params) {
      if (params[0]) return renderDetail(view, params[0]);
      view.innerHTML = `
        <div class="toolbar"><input id="pSearch" placeholder="Buscar por nombre, CUIT o teléfono" style="min-width:280px">
          <label class="check"><input type="checkbox" id="pDebt"> Solo con saldo</label>
          <span class="spacer"></span><button class="btn primary" id="pNew">➕ Nuevo ${singular.toLowerCase()}</button></div>
        <div class="card" style="padding:0"><div class="table-wrap"><table class="table">
          <thead><tr><th>Nombre</th><th>CUIT/DNI</th><th>Teléfono</th>${isCustomer ? '<th>Lista</th>' : ''}<th class="n">Saldo CC</th><th></th></tr></thead>
          <tbody id="pBody"></tbody></table></div></div>`;
      let rows = [];
      const load = safe(async () => {
        const q = new URLSearchParams({ q: $('#pSearch').value, with_balance: $('#pDebt').checked ? '1' : '' });
        rows = await api(`/${endpoint}?` + q);
        $('#pBody').innerHTML = rows.length
          ? rows
              .map(
                (p) => `<tr><td><a href="#/${key}/${p.id}"><b>${esc(p.name)}</b></a></td><td>${esc(p.tax_id || '')}</td><td>${esc(p.phone || '')}</td>
            ${isCustomer ? `<td>${esc(p.price_list_name || '(predeterminada)')}</td>` : ''}
            <td class="n">${signed(p.balance)}</td>
            <td class="actions"><button class="btn sm" data-pay="${p.id}">${isCustomer ? '💰 Cobrar' : '💸 Pagar'}</button>
              <a class="btn sm" href="#/${key}/${p.id}">📒 Cuenta</a>
              <button class="btn sm" data-edit="${p.id}">✏️</button><button class="btn sm danger" data-del="${p.id}">✕</button></td></tr>`
              )
              .join('')
          : `<tr><td colspan="6" class="empty">No hay ${plural.toLowerCase()}</td></tr>`;
      });
      $('#pSearch').oninput = debounce(load);
      $('#pDebt').onchange = load;
      $('#pNew').onclick = () => form(null, load);
      $('#pBody').onclick = safe(async (e) => {
        const d = e.target.dataset;
        const row = rows.find((r) => String(r.id) === String(d.edit || d.pay || d.del));
        if (!row) return;
        if (d.edit) form(row, load);
        if (d.pay) paymentForm(row, load);
        if (d.del && (await confirmDialog(`¿Eliminar a ${row.name}? Si tiene movimientos se dará de baja pero se conserva el historial.`, 'Eliminar'))) {
          await api(`/${endpoint}/${row.id}`, { method: 'DELETE' });
          load();
        }
      });
      load();
    },
  };

  async function renderDetail(view, id) {
    const [d, lists] = await Promise.all([api(`/${endpoint}/${id}/account`), isCustomer ? cache.lists() : []]);
    const p = d.party;
    p.balance = d.balance;
    $('#pageTitle').textContent = `${singular}: ${p.name}`;
    const listId = p.price_list_id || defaultList(lists);
    const ops = await api(`/${isCustomer ? 'sales?customer_id' : 'purchases?supplier_id'}=${p.id}&limit=20`);
    view.innerHTML = `
      <div class="toolbar"><a class="btn" href="#/${key}">← Volver</a><span class="spacer"></span>
        <button class="btn primary" id="dPay">${isCustomer ? '💰 Registrar cobro' : '💸 Registrar pago'}</button>
        <button class="btn" id="dEdit">✏️ Editar</button>
        ${isCustomer ? '<button class="btn" id="dShop">🔗 Link de pedidos</button>' : ''}
        ${isCustomer ? `<a class="btn" download href="/api/price-lists/${listId}/export.pdf?customer_id=${p.id}">🏷️ Lista de precios (PDF)</a>
          <a class="btn" href="/api/price-lists/${listId}/export.xlsx?customer_id=${p.id}">📊 Lista Excel</a>` : ''}
      </div>
      <div class="grid cols-3">
        <div class="stat ${d.balance > 0 ? (isCustomer ? 'warn' : 'danger') : 'ok'}"><div class="label">${isCustomer ? 'Saldo que nos debe' : 'Saldo que le debemos'}</div><div class="value">${money(d.balance)}</div>
          ${isCustomer && p.credit_limit ? `<div class="sub">Límite de crédito: ${money(p.credit_limit)}</div>` : ''}</div>
        <div class="card" style="margin:0"><div class="muted">Datos</div>${esc(p.tax_id || '')}<br>${esc(p.phone || '')} ${esc(p.email || '')}<br>${esc(p.address || '')}</div>
        <div class="card" style="margin:0"><div class="muted">Notas</div>${esc(p.notes || '—')}</div>
      </div>
      <div class="grid cols-2" style="margin-top:16px">
        <div class="card" style="padding:0"><h2 style="padding:16px 16px 0">📒 Cuenta corriente</h2><div class="table-wrap"><table class="table">
          <thead><tr><th>Fecha</th><th>Concepto</th><th class="n">Debe</th><th class="n">Haber</th><th class="n">Saldo</th></tr></thead>
          <tbody>${d.movements.length ? d.movements.map((m) => `<tr><td>${esc(m.date)}</td><td>${esc(m.concept)}</td>
            <td class="n">${m.amount > 0 ? money(m.amount) : ''}</td><td class="n">${m.amount < 0 ? money(-m.amount) : ''}</td><td class="n"><b>${money(m.balance)}</b></td></tr>`).join('') : '<tr><td colspan="5" class="empty">Sin movimientos</td></tr>'}</tbody></table></div></div>
        <div class="card" style="padding:0"><h2 style="padding:16px 16px 0">${isCustomer ? '🧾 Últimas ventas' : '📋 Últimas compras'}</h2><div class="table-wrap"><table class="table">
          <thead><tr><th>#</th><th>Fecha</th><th class="n">Total</th><th class="n">A cuenta</th><th></th></tr></thead>
          <tbody>${ops.length ? ops.map((o) => `<tr><td>${o.id}</td><td>${esc(o.date)}</td><td class="n">${money(o.total)}</td><td class="n">${money(o.on_account)}</td>
            <td>${o.status !== 'ok' ? '<span class="badge danger">Anulada</span>' : isCustomer ? `<a class="btn sm" download href="/api/sales/${o.id}/pdf">⬇️ PDF</a>` : ''}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">Sin operaciones</td></tr>'}</tbody></table></div></div>
      </div>`;
    const reload = () => renderDetail(view, id);
    $('#dPay').onclick = () => paymentForm(p, reload);
    $('#dEdit').onclick = () => form(p, reload);
    if (isCustomer) $('#dShop').onclick = () => shopLinkModal(p);
  }
}

partyViews({ key: 'clientes', endpoint: 'customers', singular: 'Cliente', plural: 'Clientes', isCustomer: true });
partyViews({ key: 'proveedores', endpoint: 'suppliers', singular: 'Proveedor', plural: 'Proveedores', isCustomer: false });

/** Link personal del cliente a la tienda online (con sus precios y sus datos) */
async function shopLinkModal(customer, regenerate = false) {
  const { token } = await api(`/customers/${customer.id}/shop-link`, { method: 'POST', body: { regenerate } });
  const url = `${location.origin}/tienda?c=${token}`;
  const phone = String(customer.phone || '').replace(/\D/g, '');
  const text = `¡Hola ${customer.name}! Te paso el link para ver nuestro catálogo con tus precios y hacer pedidos: ${url}`;
  modal({
    title: `Link de pedidos — ${customer.name}`,
    body: `<p class="muted">Con este link el cliente ve el catálogo con <b>sus precios</b> y sus datos ya cargados. Es personal: no lo compartas con otros.</p>
      <div style="display:flex;gap:6px"><input id="shopUrl" value="${esc(url)}" readonly style="flex:1"><button class="btn" id="copyUrl">📋 Copiar</button></div>
      <div class="toolbar" style="margin-top:12px">
        <a class="btn ok" target="_blank" rel="noopener" href="https://wa.me/${phone}?text=${encodeURIComponent(text)}">Enviar por WhatsApp</a>
        <a class="btn" target="_blank" href="${esc(url)}">Abrir</a>
        <button class="btn danger" id="regen" title="El link anterior deja de funcionar">Generar link nuevo</button>
      </div>${phone ? '' : '<p class="muted">El cliente no tiene teléfono cargado: WhatsApp te va a pedir elegir el contacto.</p>'}`,
    actions: [{ label: 'Cerrar', cls: 'primary' }],
    onOpen(el, close) {
      $('#copyUrl', el).onclick = async () => {
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          $('#shopUrl', el).select();
          document.execCommand('copy');
        }
        toast('Link copiado', 'ok');
      };
      $('#regen', el).onclick = safe(async () => {
        if (!(await confirmDialog('¿Generar un link nuevo? El anterior deja de funcionar.', 'Generar'))) return;
        close();
        shopLinkModal(customer, true);
      });
    },
  });
}

// ---------- Resumen de cuentas corrientes ----------
views.cuentas = {
  title: 'Cuentas corrientes',
  async render(view) {
    const [cus, sup] = await Promise.all([api('/customers?with_balance=1'), api('/suppliers?with_balance=1')]);
    const sum = (r) => r.reduce((a, x) => a + x.balance, 0);
    const table = (rows, key, label) => `<table class="table"><thead><tr><th>${label}</th><th>Teléfono</th><th class="n">Saldo</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.sort((a, b) => b.balance - a.balance).map((r) => `<tr><td><a href="#/${key}/${r.id}">${esc(r.name)}</a></td><td>${esc(r.phone || '')}</td><td class="n"><b>${signed(r.balance)}</b></td>
        <td class="actions"><a class="btn sm" href="#/${key}/${r.id}">Ver cuenta</a></td></tr>`).join('') : '<tr><td colspan="4" class="empty">Sin saldos pendientes</td></tr>'}</tbody></table>`;
    view.innerHTML = `
      <div class="grid cols-3">
        <div class="stat ok"><div class="label">Total a cobrar (clientes)</div><div class="value">${money(sum(cus))}</div></div>
        <div class="stat danger"><div class="label">Total a pagar (proveedores)</div><div class="value">${money(sum(sup))}</div></div>
        <div class="stat"><div class="label">Posición neta</div><div class="value">${money(sum(cus) - sum(sup))}</div></div>
      </div>
      <div class="grid cols-2" style="margin-top:16px">
        <div class="card" style="padding:0"><h2 style="padding:16px 16px 0">👥 Clientes que nos deben</h2><div class="table-wrap">${table(cus, 'clientes', 'Cliente')}</div></div>
        <div class="card" style="padding:0"><h2 style="padding:16px 16px 0">🚚 Proveedores a los que debemos</h2><div class="table-wrap">${table(sup, 'proveedores', 'Proveedor')}</div></div>
      </div>
      <p class="muted">Saldo positivo = deuda pendiente. Saldo negativo = saldo a favor (pago anticipado).</p>`;
  },
};

// ---------- Catálogo / inventario ----------
/** Genera un EAN-13 interno (prefijo 20, uso en el local) con dígito verificador */
function generateEAN() {
  let base = '20' + String(Date.now()).slice(-10);
  const sum = base.split('').reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return base + ((10 - (sum % 10)) % 10);
}

async function productForm(id, onSaved) {
  const [lists, cats, p] = await Promise.all([cache.lists(), cache.categories(true), id ? api('/products/' + id) : null]);
  const prod = p || { units_per_pack: 1, active: 1 };
  const fixedPrice = (listId) => {
    const pr = prod.prices && prod.prices.find((x) => x.price_list_id === listId);
    return pr && pr.fixed ? pr.price : '';
  };
  modal({
    title: id ? 'Editar producto' : 'Nuevo producto',
    wide: true,
    body: `<div style="display:flex;gap:18px;flex-wrap:wrap">
      <div style="display:flex;flex-direction:column;gap:8px;align-items:center">
        <div class="img-preview" id="imgPreview">${prod.image_url ? `<img src="${esc(prod.image_url)}">` : '🍾'}</div>
        <label class="btn sm">📷 Cargar foto<input type="file" id="imgInput" accept="image/*" hidden></label>
        ${prod.image_url ? '<label class="check muted"><input type="checkbox" name="remove_image"> Quitar foto</label>' : ''}
      </div>
      <div class="form-grid" style="flex:1;min-width:280px">
        ${field('Nombre *', `<input name="name" value="${esc(prod.name)}" placeholder="Ej: Coca-Cola Original 2.25L">`, 'full')}
        ${field('Código de barras', `<div style="display:flex;gap:6px"><input name="barcode" value="${esc(prod.barcode)}" style="flex:1" placeholder="Escaneá el código" data-noenter="1"><button type="button" class="btn sm" id="genEan" title="Generar código interno">⚙️</button></div>`)}
        ${field('Código interno', `<input name="code" value="${esc(prod.code)}">`)}
        ${field('Categoría', `<div style="display:flex;gap:6px"><select name="category_id" style="flex:1"><option value="">— Sin categoría —</option>${cats.map((c) => opt(c.id, c.name, prod.category_id)).join('')}</select><button type="button" class="btn sm" id="newCat" title="Crear categoría">➕</button></div>`)}
        ${field('Marca', `<input name="brand" value="${esc(prod.brand)}">`)}
        ${field('Presentación', `<input name="presentation" value="${esc(prod.presentation)}" placeholder="Ej: Lata 473ml">`)}
        ${field('Unidades por bulto / pack', `<input name="units_per_pack" value="${prod.units_per_pack || 1}">`)}
        ${field('Costo unitario', `<input name="cost" id="costInput" value="${prod.cost ?? ''}" inputmode="decimal">`)}
        ${field(id ? 'Stock actual (ajustalo desde “Stock”)' : 'Stock inicial', `<input name="stock" value="${id ? qty(prod.stock) : ''}" ${id ? 'disabled' : ''}>`)}
        ${field('Stock mínimo (alerta)', `<input name="min_stock" value="${prod.min_stock || ''}">`)}
        ${field('Descripción', `<input name="description" value="${esc(prod.description)}">`)}
      </div></div>
      <h4 style="margin:18px 0 8px">🏷️ Precios por lista</h4>
      <p class="muted" style="margin-top:0">Dejá vacío para usar el recargo automático de la lista sobre el costo.</p>
      <div class="form-grid" id="priceInputs">${lists
        .map((l) => field(`${l.name} (+${l.markup}%)`, `<input data-list="${l.id}" data-markup="${l.markup}" value="${fixedPrice(l.id)}" inputmode="decimal">`))
        .join('')}</div>`,
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Guardar',
        cls: 'primary',
        onClick: async (el) => {
          const f = formData(el);
          const fd = new FormData();
          for (const [k, v] of Object.entries(f)) {
            if (k === 'remove_image') fd.append(k, v ? '1' : '0');
            else if (['cost', 'min_stock', 'units_per_pack', 'stock'].includes(k)) fd.append(k, num(v));
            else fd.append(k, v);
          }
          const prices = {};
          $$('[data-list]', el).forEach((i) => (prices[i.dataset.list] = i.value.trim() === '' ? '' : num(i.value)));
          fd.append('prices', JSON.stringify(prices));
          const file = $('#imgInput', el).files[0];
          if (file) fd.append('image', file);
          const r = id ? await api('/products/' + id, { method: 'PUT', form: fd }) : await api('/products', { method: 'POST', form: fd });
          toast('Producto guardado', 'ok');
          onSaved && onSaved(id || r.id);
        },
      },
    ],
    onOpen(el) {
      $('#imgInput', el).onchange = (e) => {
        const file = e.target.files[0];
        if (file) $('#imgPreview', el).innerHTML = `<img src="${URL.createObjectURL(file)}">`;
      };
      $('#genEan', el).onclick = () => ($('[name=barcode]', el).value = generateEAN());
      $('#newCat', el).onclick = () =>
        modal({
          title: 'Nueva categoría',
          body: field('Nombre', '<input name="name" placeholder="Ej: Cervezas">'),
          actions: [
            { label: 'Cancelar' },
            {
              label: 'Crear',
              cls: 'primary',
              onClick: async (m) => {
                const c = await api('/categories', { method: 'POST', body: formData(m) });
                const sel = $('[name=category_id]', el);
                sel.insertAdjacentHTML('beforeend', opt(c.id, c.name));
                sel.value = c.id;
                cache._cats = null;
                toast(`Categoría "${c.name}" creada`, 'ok');
              },
            },
          ],
        });
      const updatePlaceholders = () => {
        const cost = num($('#costInput', el).value);
        $$('[data-list]', el).forEach((i) => (i.placeholder = `Auto: ${money(cost * (1 + Number(i.dataset.markup) / 100))}`));
      };
      $('#costInput', el).oninput = updatePlaceholders;
      updatePlaceholders();
    },
  });
}

function stockForm(p, onSaved) {
  modal({
    title: `Ajustar stock — ${p.name}`,
    body: `<p>Stock actual: <b>${qty(p.stock)}</b></p><div class="form-grid">
      ${field('Operación', '<select name="op"><option value="sumar">Sumar (ingreso)</option><option value="restar">Restar (rotura, pérdida, consumo)</option><option value="fijar">Fijar stock exacto (conteo)</option></select>')}
      ${field('Cantidad', '<input name="quantity" inputmode="decimal">')}
      ${field('Motivo', '<input name="notes" placeholder="Ej: Rotura, conteo físico">', 'full')}</div>`,
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Aplicar',
        cls: 'primary',
        onClick: async (el) => {
          const f = formData(el);
          const n = num(f.quantity);
          const body = { notes: f.notes };
          if (f.op === 'fijar') body.set_to = n;
          else body.quantity = f.op === 'restar' ? -n : n;
          const r = await api(`/products/${p.id}/stock`, { method: 'POST', body });
          toast(`Stock actualizado: ${qty(r.stock)}`, 'ok');
          onSaved && onSaved();
        },
      },
    ],
  });
}

async function movementsModal(p) {
  const rows = await api(`/products/${p.id}/movements`);
  modal({
    title: `Movimientos de stock — ${p.name}`,
    wide: true,
    body: `<table class="table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Ref.</th><th>Detalle</th><th class="n">Cantidad</th></tr></thead><tbody>
      ${rows.length ? rows.map((m) => `<tr><td>${esc(m.date)}</td><td><span class="badge">${esc(m.type)}</span></td><td>${m.ref_id ? '#' + m.ref_id : ''}</td><td>${esc(m.notes || '')}</td>
      <td class="n ${m.quantity > 0 ? 'pos' : 'neg'}">${m.quantity > 0 ? '+' : ''}${qty(m.quantity)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">Sin movimientos</td></tr>'}</tbody></table>`,
    actions: [{ label: 'Cerrar', cls: 'primary' }],
  });
}

const catalogState = { mode: localStorage.getItem('catalogMode') || 'grid', q: '', category_id: '', low: false, list: '' };

views.catalogo = {
  title: 'Catálogo y stock',
  async render(view) {
    const [lists, cats] = await Promise.all([cache.lists(), cache.categories(true)]);
    if (!catalogState.list) catalogState.list = defaultList(lists);
    view.innerHTML = `
      <div class="toolbar">
        <input id="cSearch" placeholder="🔍 Buscar o escanear código" value="${esc(catalogState.q)}" style="min-width:260px">
        <select id="cCat"><option value="">Todas las categorías</option>${cats.map((c) => opt(c.id, `${c.name} (${c.products})`, catalogState.category_id)).join('')}</select>
        <select id="cList" title="Lista de precios a mostrar">${lists.map((l) => opt(l.id, 'Precios: ' + l.name, catalogState.list)).join('')}</select>
        <label class="check"><input type="checkbox" id="cLow" ${catalogState.low ? 'checked' : ''}> Stock bajo</label>
        <span class="spacer"></span>
        <button class="btn" id="cMode">${catalogState.mode === 'grid' ? '☰ Ver tabla' : '▦ Ver tarjetas'}</button>
        <a class="btn" href="#/importar">📥 Importar</a>
        <button class="btn primary" id="cNew">➕ Nuevo producto</button>
      </div>
      <div id="cStats" class="muted" style="margin-bottom:8px"></div>
      <div id="cBody"></div>`;
    let rows = [];
    const load = safe(async () => {
      const q = new URLSearchParams({ q: catalogState.q, category_id: catalogState.category_id, low_stock: catalogState.low ? '1' : '', price_list_id: catalogState.list, limit: 2000 });
      rows = await api('/products?' + q);
      const units = rows.reduce((a, p) => a + Math.max(0, p.stock), 0);
      const value = rows.reduce((a, p) => a + Math.max(0, p.stock) * p.cost, 0);
      $('#cStats').innerHTML = `${rows.length} productos · ${qty(units)} unidades en stock · valorizado al costo ${money(value)}`;
      const stockBadge = (p) => `<span class="badge ${p.stock <= 0 ? 'danger' : p.stock <= p.min_stock ? 'warn' : 'ok'}">Stock: ${qty(p.stock)}</span>`;
      if (!rows.length) {
        $('#cBody').innerHTML = '<div class="card empty">No hay productos. Creá uno nuevo o importalos desde un archivo Excel/CSV.</div>';
        return;
      }
      if (catalogState.mode === 'grid') {
        $('#cBody').innerHTML = `<div class="product-grid">${rows
          .map(
            (p) => `<div class="pcard" data-edit="${p.id}"><div class="img">${p.image_url ? `<img src="${esc(p.image_url)}" loading="lazy">` : '🍾'}</div>
            <div class="body"><div class="name">${esc(p.name)}</div><div class="muted">${esc([p.brand, p.presentation].filter(Boolean).join(' · '))}</div>
            <div class="muted" style="font-size:12px">${esc(p.barcode || p.code || '')}</div>
            <div>${stockBadge(p)} ${p.units_per_pack > 1 ? `<span class="badge">x${p.units_per_pack}</span>` : ''}</div>
            <div class="price">${money(p.price)}</div>
            <div class="toolbar" style="margin:6px 0 0"><button class="btn sm" data-stock="${p.id}">📦 Stock</button><button class="btn sm" data-movs="${p.id}">📜</button></div></div></div>`
          )
          .join('')}</div>`;
      } else {
        $('#cBody').innerHTML = `<div class="card" style="padding:0"><div class="table-wrap"><table class="table">
          <thead><tr><th></th><th>Producto</th><th>Código barras</th><th>Código</th><th>Categoría</th><th class="n">Stock</th><th class="n">Mín.</th><th class="n">Costo</th><th class="n">Precio</th><th class="n">Margen</th><th></th></tr></thead>
          <tbody>${rows
            .map(
              (p) => `<tr><td>${p.image_url ? `<img class="thumb" src="${esc(p.image_url)}" loading="lazy">` : '<div class="thumb"></div>'}</td>
            <td><b>${esc(p.name)}</b><div class="muted">${esc([p.brand, p.presentation].filter(Boolean).join(' · '))}</div></td>
            <td>${esc(p.barcode || '')}</td><td>${esc(p.code || '')}</td><td>${esc(p.category_name || '')}</td>
            <td class="n">${stockBadge(p)}</td><td class="n">${qty(p.min_stock)}</td><td class="n">${money(p.cost)}</td><td class="n"><b>${money(p.price)}</b></td>
            <td class="n muted">${p.cost > 0 ? Math.round(((p.price - p.cost) / p.cost) * 100) + '%' : ''}</td>
            <td class="actions"><button class="btn sm" data-stock="${p.id}">📦</button><button class="btn sm" data-movs="${p.id}">📜</button>
              <button class="btn sm" data-edit="${p.id}">✏️</button><button class="btn sm danger" data-del="${p.id}">✕</button></td></tr>`
            )
            .join('')}</tbody></table></div></div>`;
      }
    });
    $('#cSearch').oninput = debounce((e) => {
      catalogState.q = e.target.value;
      load();
    });
    $('#cCat').onchange = (e) => { catalogState.category_id = e.target.value; load(); };
    $('#cList').onchange = (e) => { catalogState.list = e.target.value; load(); };
    $('#cLow').onchange = (e) => { catalogState.low = e.target.checked; load(); };
    $('#cMode').onclick = () => {
      catalogState.mode = catalogState.mode === 'grid' ? 'table' : 'grid';
      localStorage.setItem('catalogMode', catalogState.mode);
      views.catalogo.render(view);
    };
    $('#cNew').onclick = () => productForm(null, load);
    $('#cBody').onclick = safe(async (e) => {
      const btn = e.target.closest('[data-stock],[data-movs],[data-del],[data-edit]');
      if (!btn) return;
      const d = btn.dataset;
      const p = rows.find((r) => String(r.id) === String(d.stock || d.movs || d.del || d.edit));
      if (!p) return;
      e.stopPropagation();
      if (d.stock) return stockForm(p, load);
      if (d.movs) return movementsModal(p);
      if (d.del) {
        if (await confirmDialog(`¿Eliminar "${p.name}"? Si tiene ventas o compras se dará de baja y se conserva el historial.`, 'Eliminar')) {
          const r = await api('/products/' + p.id, { method: 'DELETE' });
          toast(r.deactivated ? 'Producto dado de baja' : 'Producto eliminado', 'ok');
          load();
        }
        return;
      }
      if (d.edit) productForm(p.id, load);
    });
    load();
  },
};

// ---------- Categorías ----------
views.categorias = {
  title: 'Categorías',
  async render(view) {
    const cats = await cache.categories(true);
    view.innerHTML = `<div class="toolbar"><input id="catName" placeholder="Nueva categoría (ej: Cervezas, Vinos, Aguas)" style="min-width:300px">
      <button class="btn primary" id="catAdd">➕ Agregar</button></div>
      <div class="card" style="padding:0;max-width:640px"><table class="table"><thead><tr><th>Categoría</th><th class="n">Productos</th><th></th></tr></thead><tbody>
      ${cats.length ? cats.map((c) => `<tr><td>${esc(c.name)}</td><td class="n">${c.products}</td><td class="actions"><button class="btn sm" data-edit="${c.id}">✏️</button><button class="btn sm danger" data-del="${c.id}">✕</button></td></tr>`).join('') : '<tr><td colspan="3" class="empty">Sin categorías</td></tr>'}
      </tbody></table></div>`;
    const reload = () => views.categorias.render(view);
    const add = safe(async () => {
      const c = await api('/categories', { method: 'POST', body: { name: $('#catName').value } });
      toast(`Categoría "${c.name}" creada`, 'ok');
      reload();
    });
    $('#catAdd').onclick = add;
    // Ojo: un handler on* que devuelve false cancela la tecla; por eso no se usa "e.key === 'Enter' && add()"
    $('#catName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') add();
    });
    view.querySelector('tbody').onclick = safe(async (e) => {
      const d = e.target.dataset;
      const c = cats.find((x) => String(x.id) === String(d.edit || d.del));
      if (!c) return;
      if (d.edit)
        modal({
          title: 'Renombrar categoría',
          body: field('Nombre', `<input name="name" value="${esc(c.name)}">`),
          actions: [{ label: 'Cancelar' }, { label: 'Guardar', cls: 'primary', onClick: async (el) => { await api('/categories/' + c.id, { method: 'PUT', body: formData(el) }); reload(); } }],
        });
      if (d.del && (await confirmDialog(`¿Eliminar la categoría "${c.name}"? Los productos quedarán sin categoría.`, 'Eliminar'))) {
        await api('/categories/' + c.id, { method: 'DELETE' });
        reload();
      }
    });
  },
};

// ---------- Listas de precios ----------
views.listas = {
  title: 'Listas de precios',
  async render(view) {
    const [lists, cats, customers] = await Promise.all([cache.lists(true), cache.categories(true), api('/customers')]);
    view.innerHTML = `
      <div class="toolbar"><span class="spacer"></span><button class="btn primary" id="lNew">➕ Nueva lista</button></div>
      <div class="card" style="padding:0"><table class="table"><thead><tr><th>Lista</th><th>Descripción</th><th class="n">Recargo s/ costo</th><th></th><th></th></tr></thead><tbody>
        ${lists.map((l) => `<tr><td><b>${esc(l.name)}</b> ${l.is_default ? '<span class="badge info">Predeterminada</span>' : ''}</td><td>${esc(l.description || '')}</td>
          <td class="n">${l.markup}%</td>
          <td class="actions"><button class="btn sm" data-adjust="${l.id}">📈 Actualizar precios</button></td>
          <td class="actions"><button class="btn sm" data-edit="${l.id}">✏️</button><button class="btn sm danger" data-del="${l.id}">✕</button></td></tr>`).join('')}
      </tbody></table></div>
      <div class="card"><h2>⬇️ Descargar lista de precios</h2>
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
          ${field('Lista', `<select id="dList">${lists.map((l) => opt(l.id, l.name, defaultList(lists))).join('')}</select>`)}
          ${field('O según el cliente', `<select id="dCustomer"><option value="">—</option>${customers.map((c) => opt(c.id, `${c.name}${c.price_list_name ? ' (' + c.price_list_name + ')' : ''}`)).join('')}</select>`)}
          ${field('Categoría', `<select id="dCat"><option value="">Todas</option>${cats.map((c) => opt(c.id, c.name)).join('')}</select>`)}
          <div class="field"><label>Opciones</label><label class="check"><input type="checkbox" id="dStock"> Solo productos con stock</label>
            <label class="check"><input type="checkbox" id="dPhotos"> Incluir fotos</label></div>
        </div>
        <div class="toolbar" style="margin-top:12px">
          <button class="btn primary" id="dXlsx">📊 Descargar Excel</button>
          <button class="btn primary" id="dPdf">📄 Descargar PDF</button>
          <button class="btn" id="dCatalog">🖼️ Catálogo con fotos (PDF)</button>
          <button class="btn" id="dPrint">🖨️ Imprimir</button>
        </div>
        <p class="muted">El PDF se descarga directo, listo para mandar por WhatsApp o email. Las fotos en PDF tienen que ser JPG o PNG.</p>
      </div>`;
    const params = (extra = {}) => {
      const q = new URLSearchParams({ category_id: $('#dCat').value, only_stock: $('#dStock').checked ? '1' : '', customer_id: $('#dCustomer').value, ...extra });
      return `${$('#dList').value}/__?${q}`;
    };
    $('#dXlsx').onclick = () => (location.href = '/api/price-lists/' + params().replace('__', 'export.xlsx'));
    $('#dPdf').onclick = () => download('/api/price-lists/' + params({ photos: $('#dPhotos').checked ? '1' : '' }).replace('__', 'export.pdf'));
    $('#dCatalog').onclick = () => download('/api/price-lists/' + params({ layout: 'catalogo' }).replace('__', 'export.pdf'));
    $('#dPrint').onclick = () => window.open('/api/price-lists/' + params({ photos: $('#dPhotos').checked ? '1' : '' }).replace('__', 'print'), '_blank');

    const reload = () => {
      cache.invalidate();
      views.listas.render(view);
    };
    const listForm = (l) =>
      modal({
        title: l ? 'Editar lista' : 'Nueva lista de precios',
        body: `<div class="form-grid">
          ${field('Nombre *', `<input name="name" value="${esc(l && l.name)}" placeholder="Ej: Mayorista, Bares, Distribuidor">`)}
          ${field('Recargo sobre el costo (%)', `<input name="markup" value="${l ? l.markup : ''}" inputmode="decimal">`)}
          ${field('Descripción', `<input name="description" value="${esc(l && l.description)}">`, 'full')}
          <label class="check full"><input type="checkbox" name="is_default" ${l && l.is_default ? 'checked' : ''}> Lista predeterminada (para consumidor final)</label></div>`,
        actions: [
          { label: 'Cancelar' },
          {
            label: 'Guardar',
            cls: 'primary',
            onClick: async (el) => {
              const f = formData(el);
              f.markup = num(f.markup);
              await api(l ? '/price-lists/' + l.id : '/price-lists', { method: l ? 'PUT' : 'POST', body: f });
              reload();
            },
          },
        ],
      });
    $('#lNew').onclick = () => listForm(null);
    view.querySelector('tbody').onclick = safe(async (e) => {
      const d = e.target.dataset;
      const l = lists.find((x) => String(x.id) === String(d.edit || d.del || d.adjust));
      if (!l) return;
      if (d.edit) listForm(l);
      if (d.del && (await confirmDialog(`¿Eliminar la lista "${l.name}"? Se borran los precios fijos cargados en ella.`, 'Eliminar'))) {
        await api('/price-lists/' + l.id, { method: 'DELETE' });
        reload();
      }
      if (d.adjust)
        modal({
          title: `Actualizar precios — ${l.name}`,
          body: `<div class="form-grid">
            ${field('Qué actualizar', '<select name="mode"><option value="precios">Precios de esta lista</option><option value="costos">Costos de los productos (afecta a todas las listas automáticas)</option></select>', 'full')}
            ${field('Porcentaje (negativo para bajar)', '<input name="percent" placeholder="Ej: 10" inputmode="decimal">')}
            ${field('Categoría', `<select name="category_id"><option value="">Todas</option>${cats.map((c) => opt(c.id, c.name)).join('')}</select>`)}</div>
            <p class="muted">“Precios de esta lista” fija el precio actual × (1 + %) en cada producto de la lista.</p>`,
          actions: [
            { label: 'Cancelar' },
            {
              label: 'Aplicar',
              cls: 'primary',
              onClick: async (el) => {
                const f = formData(el);
                f.percent = num(f.percent);
                if (!f.percent) throw new Error('Indicá un porcentaje');
                const r = await api(`/price-lists/${l.id}/adjust`, { method: 'POST', body: f });
                toast(`${r.updated} productos actualizados`, 'ok');
              },
            },
          ],
        });
    });
  },
};

// ---------- Importar / exportar ----------
views.importar = {
  title: 'Importar / Exportar',
  async render(view) {
    view.innerHTML = `
      <div class="grid cols-2">
        <div class="card"><h2>📥 Carga masiva de productos (Excel / CSV)</h2>
          <ol class="muted" style="padding-left:18px;line-height:1.7">
            <li>Descargá la <a href="/api/import/template.xlsx">plantilla de Excel</a> (o exportá tu inventario actual para editarlo).</li>
            <li>Completá una fila por producto. Solo <b>nombre</b> es obligatorio.</li>
            <li>Si el <b>código de barras</b> o <b>código</b> ya existe, el producto se actualiza; si no, se crea.</li>
          </ol>
          <div class="field"><label>Archivo (.xlsx o .csv)</label><input type="file" id="impFile" accept=".xlsx,.csv,.txt"></div>
          <div class="form-grid" style="margin-top:10px">
            ${field('Columna stock', '<select id="impStock"><option value="reemplazar">Reemplaza el stock actual</option><option value="sumar">Se suma al stock actual</option></select>')}
            ${field('Productos existentes', '<select id="impUpdate"><option value="1">Actualizarlos</option><option value="0">Ignorarlos (solo crear nuevos)</option></select>')}
          </div>
          <div class="toolbar" style="margin-top:12px"><button class="btn primary" id="impGo">Importar productos</button></div>
          <div id="impResult"></div>
        </div>
        <div>
          <div class="card"><h2>🖼️ Carga masiva de fotos</h2>
            <p class="muted">Seleccioná varias imágenes a la vez. Cada archivo debe llamarse como el <b>código de barras</b> o el <b>código interno</b> del producto. Ej: <code>7790895000997.jpg</code></p>
            <input type="file" id="imgFiles" accept="image/*" multiple>
            <div class="toolbar" style="margin-top:12px"><button class="btn primary" id="imgGo">Subir fotos</button></div>
            <div id="imgResult"></div>
          </div>
          <div class="card"><h2>📤 Exportar</h2>
            <div class="toolbar">
              <a class="btn" href="/api/products/export.xlsx">📊 Inventario completo (Excel)</a>
              <a class="btn" href="/api/import/template.xlsx">📄 Plantilla vacía</a>
              <a class="btn" href="#/listas">🏷️ Listas de precios</a>
            </div>
            <p class="muted">El Excel del inventario tiene el mismo formato que la plantilla: podés editar precios/stock y volver a importarlo.</p>
          </div>
        </div>
      </div>`;
    $('#impGo').onclick = safe(async () => {
      const file = $('#impFile').files[0];
      if (!file) throw new Error('Elegí un archivo');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('stock_mode', $('#impStock').value);
      fd.append('update_existing', $('#impUpdate').value);
      $('#impGo').disabled = true;
      try {
        const r = await api('/import/products', { method: 'POST', form: fd });
        cache.invalidate();
        $('#impResult').innerHTML = `<div class="card" style="margin-top:12px;background:var(--ok-soft)">
          ✅ <b>${r.created}</b> creados · <b>${r.updated}</b> actualizados · ${r.skipped} filas omitidas
          ${r.errors.length ? `<div class="neg" style="margin-top:8px"><b>${r.errors.length} errores:</b><ul>${r.errors.map((e) => `<li>Fila ${e.row}: ${esc(e.message)}</li>`).join('')}</ul></div>` : ''}</div>`;
        toast('Importación finalizada', 'ok');
      } finally {
        $('#impGo').disabled = false;
      }
    });
    $('#imgGo').onclick = safe(async () => {
      const files = $('#imgFiles').files;
      if (!files.length) throw new Error('Elegí las imágenes');
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append('images', f));
      $('#imgGo').disabled = true;
      try {
        const r = await api('/import/images', { method: 'POST', form: fd });
        $('#imgResult').innerHTML = `<div class="card" style="margin-top:12px">✅ ${r.matched} fotos asignadas
          ${r.unmatched.length ? `<div class="neg">Sin producto asociado: ${r.unmatched.map(esc).join(', ')}</div>` : ''}</div>`;
      } finally {
        $('#imgGo').disabled = false;
      }
    });
  },
};

// ---------- Configuración ----------
views.config = {
  title: 'Configuración',
  async render(view) {
    const [s, lists] = await Promise.all([api('/settings'), cache.lists()]);
    view.innerHTML = `<div class="card" style="max-width:720px"><h2>Datos del negocio</h2>
      <p class="muted">Aparecen en los comprobantes y en las listas de precios.</p>
      <div class="form-grid" id="cfgForm">
        ${field('Nombre del negocio', `<input name="business_name" value="${esc(s.business_name)}">`, 'full')}
        ${field('Dirección', `<input name="business_address" value="${esc(s.business_address)}">`)}
        ${field('Teléfono / WhatsApp', `<input name="business_phone" value="${esc(s.business_phone)}">`)}
        ${field('CUIT', `<input name="business_tax_id" value="${esc(s.business_tax_id)}">`)}
        ${field('Condición frente al IVA', `<input name="business_iva" value="${esc(s.business_iva)}" placeholder="Ej: Monotributo">`)}
        ${field('Ingresos Brutos', `<input name="business_iibb" value="${esc(s.business_iibb)}">`)}
        ${field('Inicio de actividades', `<input name="business_start" value="${esc(s.business_start)}" placeholder="dd/mm/aaaa">`)}
        ${field('Pie de la lista de precios', `<input name="price_list_footer" value="${esc(s.price_list_footer)}" placeholder="Ej: Precios sujetos a cambio sin previo aviso">`, 'full')}
        <h3 class="full" style="font-size:14px;margin:8px 0 0">📃 Remitos X</h3>
        ${field('Punto de venta', `<input name="remito_pv" inputmode="numeric" value="${esc(s.remito_pv || 1)}">`)}
        ${field('Próximo número de remito', `<input name="remito_next" inputmode="numeric" value="${esc(s.remito_next || 1)}" title="Si ya usabas remitos en papel, poné el número con el que querés seguir">`)}
        ${field('Copias por remito', `<select name="remito_copies">${[1, 2, 3].map((n) => opt(n, n === 1 ? 'Solo original' : n === 2 ? 'Original y duplicado' : 'Original, duplicado y triplicado', s.remito_copies || 2)).join('')}</select>`)}
        ${field('Precios en el remito', `<select name="remito_valued">${opt('1', 'Valorizado (con precios)', s.remito_valued || '1')}${opt('0', 'Solo cantidades', s.remito_valued || '1')}</select>`)}
        ${field('Leyenda al pie del remito', `<input name="remito_footer" value="${esc(s.remito_footer)}" placeholder="Ej: La mercadería viaja por cuenta y riesgo del comprador">`, 'full')}
        <h3 class="full" style="font-size:14px;margin:8px 0 0">📄 Presupuestos</h3>
        ${field('Validez de los presupuestos (días)', `<input name="quote_valid_days" inputmode="numeric" value="${esc(s.quote_valid_days || 7)}">`)}
        ${field('Condiciones del presupuesto (aparecen al pie)', `<textarea name="quote_footer" rows="3" placeholder="Ej: Forma de pago: efectivo o transferencia. Entrega en 48 hs.">${esc(s.quote_footer)}</textarea>`, 'full')}
      </div>
      <div class="toolbar" style="margin-top:12px"><button class="btn primary" id="cfgSave">Guardar</button></div></div>
      <div class="card" style="max-width:720px"><h2>🛍️ Tienda online para clientes</h2>
        <p class="muted">Una página donde tus clientes ven el catálogo y te mandan pedidos por WhatsApp. Los pedidos aparecen en <a href="#/pedidos">Pedidos web</a>.</p>
        <div class="form-grid" id="shopForm">
          <label class="check full"><input type="checkbox" name="shop_enabled" ${s.shop_enabled === '1' ? 'checked' : ''}> <b>Tienda activada</b></label>
          ${field('WhatsApp que recibe los pedidos', `<input name="shop_whatsapp" value="${esc(s.shop_whatsapp || '')}" placeholder="Ej: 5493511234567 (con 549 y sin 0 ni 15)">`)}
          ${field('Precios que ve el público', `<select name="shop_price_list">${opt('', 'Lista predeterminada', s.shop_price_list || '')}${lists.map((l) => opt(l.id, 'Lista ' + l.name, s.shop_price_list || '')).join('')}${opt('none', 'No mostrar precios', s.shop_price_list || '')}</select>`)}
          ${field('Stock', `<select name="shop_stock_mode">${opt('disponible', 'Mostrar "Disponible / Últimas unidades / Sin stock"', s.shop_stock_mode || 'disponible')}${opt('exacto', 'Mostrar la cantidad exacta', s.shop_stock_mode || 'disponible')}</select>`)}
          ${field('Pedido mínimo ($, 0 = sin mínimo)', `<input name="shop_min_order" inputmode="decimal" value="${esc(s.shop_min_order || '')}">`)}
          <label class="check full"><input type="checkbox" name="shop_hide_out_of_stock" ${s.shop_hide_out_of_stock === '1' ? 'checked' : ''}> Ocultar productos sin stock</label>
          <label class="check full"><input type="checkbox" name="shop_private" ${s.shop_private === '1' ? 'checked' : ''}> Solo para clientes con link personal (el link general no muestra nada)</label>
          ${field('Mensaje para los clientes (opcional)', `<textarea name="shop_message" rows="2" placeholder="Ej: Entregas de lunes a sábado. Pedidos antes de las 18 hs salen al día siguiente.">${esc(s.shop_message || '')}</textarea>`, 'full')}
        </div>
        <div class="toolbar" style="margin-top:12px"><button class="btn primary" id="shopSave">Guardar tienda</button>
          <span class="spacer"></span><input id="shopPublicUrl" readonly value="${esc(location.origin + '/tienda')}" style="min-width:220px"><button class="btn" id="shopCopy">📋 Copiar link</button><a class="btn" href="/tienda" target="_blank">Abrir</a></div>
        <p class="muted" style="margin-bottom:0">Los <b>precios mayoristas</b> conviene darlos con el link personal de cada cliente: entrá al cliente y tocá <b>🔗 Link de pedidos</b>. Ese link muestra la lista de precios asignada a ese cliente.</p>
      </div>
      <div class="card" style="max-width:720px"><h2>🖼️ Logo</h2>
        <p class="muted">Aparece en el menú, en la pantalla de ingreso, en presupuestos, comprobantes y listas de precios. PNG o JPG. Si no subís ninguno, se usa el logo de ETL Bebidas.</p>
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
          <div class="img-preview" id="logoPreview" style="width:180px;height:100px;background:#fff"><img src="/api/logo?v=${esc(s.logo || 'default')}"></div>
          <div class="toolbar" style="margin:0"><label class="btn primary">⬆️ Subir logo<input type="file" id="logoFile" accept="image/png,image/jpeg" hidden></label>
          ${s.logo ? '<button class="btn danger" id="logoDel">Volver al logo original</button>' : ''}</div>
        </div></div>
      <div class="card" style="max-width:720px"><h2>👤 Usuarios</h2>
        <p class="muted">Personas que pueden entrar al sistema.</p>
        <table class="table"><tbody id="usersBody"></tbody></table>
        <div class="toolbar" style="margin-top:12px"><button class="btn" id="userNew">➕ Nuevo usuario</button></div></div>
      <div class="card" style="max-width:720px"><h2>💾 Respaldo</h2>
        <p class="muted">Descargá una copia completa (base de datos + fotos) y guardala en un pendrive o en la nube. Hacelo seguido.</p>
        <div class="toolbar"><a class="btn primary" href="/api/backup.zip">⬇️ Descargar respaldo completo</a></div>
        <h3 style="font-size:14px;margin:18px 0 6px">Restaurar / traer datos de otra instalación</h3>
        <p class="muted" style="margin-top:0">Subí un respaldo descargado de acá, la carpeta <code>data</code> del sistema comprimida en .zip, o el archivo <code>sistema.db</code>.
          <b>Reemplaza todos los datos actuales</b> (productos, clientes, ventas, caja…). Los usuarios actuales se mantienen.</p>
        <input type="file" id="restoreFile" accept=".zip,.db">
        <div class="toolbar" style="margin-top:10px"><button class="btn danger" id="restoreGo">♻️ Restaurar respaldo</button></div>
        <div id="restoreResult"></div></div>`;
    const loadUsers = safe(async () => {
      const users = await api('/users');
      $('#usersBody').innerHTML = users
        .map((u) => `<tr><td><b>${esc(u.username)}</b> ${session.user && u.id === session.user.id ? '<span class="badge info">vos</span>' : ''}</td>
          <td class="muted">Creado ${esc(u.created_at)}</td>
          <td class="actions"><button class="btn sm" data-pass="${u.id}">🔑 Cambiar contraseña</button>
          ${session.user && u.id === session.user.id ? '' : `<button class="btn sm danger" data-del="${u.id}">✕</button>`}</td></tr>`)
        .join('');
    });
    $('#userNew').onclick = () =>
      modal({
        title: 'Nuevo usuario',
        body: `<div class="form-grid">${field('Usuario', '<input name="username" autocomplete="off">')}${field('Contraseña (mín. 6)', '<input name="password" type="password" autocomplete="new-password">')}</div>`,
        actions: [{ label: 'Cancelar' }, { label: 'Crear', cls: 'primary', onClick: async (el) => { await api('/users', { method: 'POST', body: formData(el) }); toast('Usuario creado', 'ok'); loadUsers(); } }],
      });
    $('#usersBody').onclick = safe(async (e) => {
      const d = e.target.dataset;
      if (d.pass)
        modal({
          title: 'Cambiar contraseña',
          body: field('Nueva contraseña (mín. 6)', '<input name="password" type="password" autocomplete="new-password">'),
          actions: [{ label: 'Cancelar' }, { label: 'Guardar', cls: 'primary', onClick: async (el) => { await api(`/users/${d.pass}/password`, { method: 'PUT', body: formData(el) }); toast('Contraseña actualizada', 'ok'); } }],
        });
      if (d.del && (await confirmDialog('¿Eliminar este usuario?', 'Eliminar'))) {
        await api('/users/' + d.del, { method: 'DELETE' });
        loadUsers();
      }
    });
    loadUsers();
    $('#restoreGo').onclick = safe(async () => {
      const file = $('#restoreFile').files[0];
      if (!file) throw new Error('Elegí el archivo de respaldo');
      if (!(await confirmDialog('Se van a REEMPLAZAR todos los datos actuales por los del respaldo. Te conviene descargar antes un respaldo de lo que hay ahora. ¿Continuar?', 'Restaurar'))) return;
      const fd = new FormData();
      fd.append('file', file);
      $('#restoreGo').disabled = true;
      $('#restoreResult').innerHTML = '<p class="muted">Restaurando… puede tardar si hay muchas fotos.</p>';
      try {
        const r = await api('/restore', { method: 'POST', form: fd });
        cache.invalidate();
        $('#restoreResult').innerHTML = `<div class="card" style="margin-top:12px;background:var(--ok-soft)">✅ Datos restaurados: ${r.products} productos, ${r.customers} clientes, ${r.suppliers} proveedores, ${r.sales} ventas, ${r.purchases} compras y ${r.photos} fotos.</div>`;
        toast('Respaldo restaurado', 'ok');
        loadBrand();
        refreshTopBalances();
      } finally {
        $('#restoreGo').disabled = false;
      }
    });
    $('#shopSave').onclick = safe(async () => {
      const f = formData($('#shopForm'));
      for (const k of ['shop_enabled', 'shop_hide_out_of_stock', 'shop_private']) f[k] = f[k] ? '1' : '0';
      f.shop_whatsapp = String(f.shop_whatsapp || '').replace(/\D/g, '');
      f.shop_min_order = String(num(f.shop_min_order) || '');
      await api('/settings', { method: 'PUT', body: f });
      toast(f.shop_enabled === '1' ? 'Tienda guardada y activada' : 'Tienda guardada (desactivada)', 'ok');
    });
    $('#shopCopy').onclick = async () => {
      try {
        await navigator.clipboard.writeText($('#shopPublicUrl').value);
      } catch {
        $('#shopPublicUrl').select();
        document.execCommand('copy');
      }
      toast('Link copiado', 'ok');
    };
    $('#logoFile').onchange = safe(async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('logo', file);
      await api('/settings/logo', { method: 'POST', form: fd });
      toast('Logo actualizado', 'ok');
      loadBrand();
      views.config.render(view);
    });
    if ($('#logoDel'))
      $('#logoDel').onclick = safe(async () => {
        await api('/settings/logo', { method: 'DELETE' });
        loadBrand();
        views.config.render(view);
      });
    $('#cfgSave').onclick = safe(async () => {
      await api('/settings', { method: 'PUT', body: formData($('#cfgForm')) });
      toast('Configuración guardada', 'ok');
      loadBrand();
    });
  },
};

// ======================= Router =======================
async function loadBrand() {
  try {
    const b = await api('/branding');
    const name = b.business_name || 'ETL Bebidas';
    $('#brandName').textContent = name;
    document.title = name;
    $('#brandLogo').innerHTML = b.has_logo ? `<img src="/api/logo?t=${Date.now()}" alt="${esc(name)}">` : '🥤';
    $('.sidebar .brand').classList.toggle('has-logo', Boolean(b.has_logo));
    return b;
  } catch {
    return {};
  }
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const name = parts[0] || '';
  const v = views[name] || views[''];
  $$('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#sidebar').classList.remove('open');
  openModals.forEach((close) => close());
  $('#pageTitle').textContent = v.title;
  const view = $('#view');
  view.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    await v.render(view, parts.slice(1));
  } catch (e) {
    view.innerHTML = `<div class="card neg">Error: ${esc(e.message)}</div>`;
  }
}

// ======================= Inicio de sesión =======================
const session = { user: null, started: false };

function showAuth(mode) {
  if ($('#authScreen')) return;
  const setup = mode === 'setup';
  const el = document.createElement('div');
  el.id = 'authScreen';
  el.className = 'auth-screen';
  el.innerHTML = `<form class="auth-card">
    <div id="authLogo" style="font-size:42px;text-align:center">🥤</div>
    <h2 style="text-align:center;margin:4px 0 4px">${setup ? 'Bienvenido' : 'Iniciar sesión'}</h2>
    <p class="muted" style="text-align:center;margin-top:0">${setup ? 'Creá el usuario administrador para empezar a usar el sistema.' : 'Ingresá con tu usuario y contraseña.'}</p>
    ${field('Usuario', '<input name="username" autocomplete="username" required>')}
    ${field(setup ? 'Contraseña (mínimo 6 caracteres)' : 'Contraseña', `<input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required>`)}
    ${setup ? field('Repetir contraseña', '<input name="password2" type="password" autocomplete="new-password" required>') : ''}
    <div class="neg" id="authError" style="min-height:18px"></div>
    <button class="btn primary lg" style="width:100%;justify-content:center">${setup ? 'Crear usuario y entrar' : 'Entrar'}</button></form>`;
  document.body.appendChild(el);
  loadBrand().then((b) => {
    if (b.has_logo) $('#authLogo', el).innerHTML = '<img src="/api/logo" alt="" style="max-height:120px;max-width:260px">';
  });
  $('input', el).focus();
  $('form', el).onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(el);
    try {
      if (setup && f.password !== f.password2) throw new Error('Las contraseñas no coinciden');
      await api(setup ? '/auth/setup' : '/auth/login', { method: 'POST', body: { username: f.username, password: f.password } });
      el.remove();
      boot();
    } catch (err) {
      $('#authError', el).textContent = err.message;
    }
  };
}

async function boot() {
  let status;
  try {
    status = await api('/auth/status');
  } catch (e) {
    $('#view').innerHTML = `<div class="card neg">No se pudo conectar con el servidor: ${esc(e.message)}</div>`;
    return;
  }
  if (status.setup_needed) return showAuth('setup');
  if (!status.user) return showAuth('login');
  session.user = status.user;
  if (status.storage_warning && !$('#storageWarning'))
    $('.main').insertAdjacentHTML(
      'afterbegin',
      '<div id="storageWarning" style="background:var(--danger);color:#fff;padding:10px 20px"><b>⚠️ Atención:</b> el servidor no tiene un volumen persistente. Los datos se van a perder en la próxima actualización. En Railway: Settings → Volumes → agregá un volumen con ruta <code>/data</code>.</div>'
    );
  $('#userName').textContent = status.user.username;
  loadBrand();
  refreshTopBalances();
  refreshPendingOrders();
  if (!session.started) {
    session.started = true;
    setInterval(() => session.user && refreshPendingOrders(), 60000);
    window.addEventListener('hashchange', route);
  }
  route();
}

$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
$('#logoutBtn').onclick = async (e) => {
  e.preventDefault();
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  session.user = null;
  $('#view').innerHTML = '';
  showAuth('login');
};
boot();
