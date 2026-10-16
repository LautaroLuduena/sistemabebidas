const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bebidas-test-'));
process.env.DATA_DIR = tmp;
const { createApp } = require('../server');
const { _test: parsers } = require('../server/routes/files');

let server;
let base;
let cookie = '';

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test('login: sin sesión no hay acceso; el primer usuario se crea con setup', async () => {
  await assert.rejects(call('GET', '/products'), (e) => e.status === 401);
  assert.equal((await call('GET', '/auth/status')).setup_needed, true);
  await call('POST', '/auth/setup', { username: 'admin', password: 'secreta123' });
  await assert.rejects(call('POST', '/auth/setup', { username: 'otro', password: 'secreta123' }), (e) => e.status === 403);
  cookie = '';
  await assert.rejects(call('POST', '/auth/login', { username: 'admin', password: 'mala' }), (e) => e.status === 401);
  await call('POST', '/auth/login', { username: 'admin', password: 'secreta123' });
  assert.equal((await call('GET', '/auth/status')).user.username, 'admin');
});
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method, url, body) {
  const opts = { method, headers: cookie ? { Cookie: cookie } : {} };
  if (body instanceof FormData) opts.body = body;
  else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}

test('parseo de números y CSV', () => {
  assert.equal(parsers.parseNumber('1.234,56'), 1234.56);
  assert.equal(parsers.parseNumber('1234.56'), 1234.56);
  assert.equal(parsers.parseNumber('$ 1.500'), 1500);
  assert.equal(parsers.parseNumber('2,5'), 2.5);
  assert.deepEqual(parsers.parseCSV('a;b\n"x;y";2\n'), [['a', 'b'], ['x;y', '2']]);
  assert.equal(parsers.normKey('Código de Barras'), 'codigo_de_barras');
});

test('flujo completo: importación, venta, cobro, compra, caja y anulación', async () => {
  const lists = await call('GET', '/price-lists');
  const minorista = lists.find((l) => l.name === 'Minorista');
  const mayorista = lists.find((l) => l.name === 'Mayorista');

  // Importación masiva por CSV
  const csv = 'codigo;codigo_barras;nombre;categoria;costo;stock;precio_mayorista\nC1;111;Cerveza 1L;Cervezas;1.000;50;1.300\nC2;222;Gaseosa 2L;Gaseosas;800;10;\n';
  const fd = new FormData();
  fd.append('file', new Blob([csv]), 'productos.csv');
  const imp = await call('POST', '/import/products', fd);
  assert.equal(imp.created, 2);
  assert.equal(imp.errors.length, 0);

  const beer = await call('GET', `/products/barcode/111?price_list_id=${mayorista.id}`);
  assert.equal(beer.price, 1300); // precio fijo de la lista mayorista
  assert.equal(beer.stock, 50);
  const soda = await call('GET', `/products/barcode/222?price_list_id=${minorista.id}`);
  assert.equal(soda.price, 1200); // 800 + 50 % de recargo

  // Cliente mayorista: venta con parte a cuenta corriente
  const { id: customerId } = await call('POST', '/customers', { name: 'Kiosco', price_list_id: mayorista.id });
  const sale = await call('POST', '/sales', {
    customer_id: customerId,
    items: [{ product_id: beer.id, quantity: 10 }],
    paid_cash: 5000,
    paid_transfer: 3000,
  });
  assert.equal(sale.total, 13000);
  assert.equal(sale.on_account, 5000);
  assert.equal((await call('GET', `/products/${beer.id}`)).stock, 40);

  // Venta sin cliente no puede quedar a cuenta
  await assert.rejects(call('POST', '/sales', { items: [{ product_id: soda.id, quantity: 1 }] }), /cliente/);

  // Vuelto en efectivo
  const s2 = await call('POST', '/sales', { items: [{ product_id: soda.id, quantity: 1 }], paid_cash: 2000 });
  assert.equal(s2.change, 800);

  // Cobro de cuenta corriente
  const pay = await call('POST', `/customers/${customerId}/payments`, { amount: 2000, box: 'transferencia' });
  assert.equal(pay.balance, 3000);

  // Compra a proveedor con saldo a cuenta
  const { id: supplierId } = await call('POST', '/suppliers', { name: 'Cervecería' });
  const pur = await call('POST', '/purchases', {
    supplier_id: supplierId,
    items: [{ product_id: beer.id, quantity: 20, unit_cost: 1100 }],
    paid_cash: 4000,
  });
  assert.equal(pur.on_account, 18000);
  const beerAfter = await call('GET', `/products/${beer.id}`);
  assert.equal(beerAfter.stock, 60);
  assert.equal(beerAfter.cost, 1100);

  let cash = await call('GET', '/cash');
  assert.equal(cash.balances.efectivo, 5000 + 1200 - 4000);
  assert.equal(cash.balances.transferencia, 3000 + 2000);

  // Traspaso entre cajas
  await call('POST', '/cash/transfer', { from: 'transferencia', to: 'efectivo', amount: 1000 });
  cash = await call('GET', '/cash');
  assert.equal(cash.balances.efectivo, 3200);
  assert.equal(cash.balances.transferencia, 4000);

  // Anular la venta revierte stock, caja y cuenta corriente
  await call('POST', `/sales/${sale.id}/cancel`);
  assert.equal((await call('GET', `/products/${beer.id}`)).stock, 70);
  assert.equal((await call('GET', `/customers/${customerId}`)).balance, -2000);
  cash = await call('GET', '/cash');
  assert.equal(cash.balances.efectivo, -1800);

  const dash = await call('GET', '/dashboard');
  assert.equal(dash.payable.total, 18000);
});

test('categorías: alta y nombre duplicado', async () => {
  const c = await call('POST', '/categories', { name: 'Energizantes' });
  assert.equal(c.name, 'Energizantes');
  await assert.rejects(call('POST', '/categories', { name: 'energizantes' }), /ya existe/);
});

test('actualización masiva de precios', async () => {
  const lists = await call('GET', '/price-lists');
  const minorista = lists.find((l) => l.name === 'Minorista');
  const soda = await call('GET', `/products/barcode/222?price_list_id=${minorista.id}`);
  await call('POST', `/price-lists/${minorista.id}/adjust`, { percent: 10 });
  const after = await call('GET', `/products/barcode/222?price_list_id=${minorista.id}`);
  assert.equal(after.price, Math.round(soda.price * 1.1 * 100) / 100);
});

test('respaldo y restauración', async () => {
  const before = await call('GET', '/products');
  const res = await fetch(base + '/backup.zip', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const zip = await res.arrayBuffer();
  // Cambio posterior al respaldo que la restauración debe deshacer
  await call('POST', '/categories', { name: 'Temporal' });
  const fd = new FormData();
  fd.append('file', new Blob([zip]), 'respaldo.zip');
  const r = await call('POST', '/restore', fd);
  assert.equal(r.products, before.length);
  const cats = await call('GET', '/categories');
  assert.ok(!cats.some((c) => c.name === 'Temporal'));
  // El usuario actual sigue pudiendo usar el sistema
  assert.equal((await call('GET', '/auth/status')).user.username, 'admin');
});

test('presupuestos: no mueven stock ni caja; al pasar a venta sí', async () => {
  const beer = await call('GET', '/products/barcode/111');
  const cashBefore = (await call('GET', '/cash')).balances;
  const q = await call('POST', '/quotes', {
    customer_name: 'Evento Pérez',
    items: [{ product_id: beer.id, quantity: 5, unit_price: 1000 }],
    discount: 500,
    valid_days: 10,
  });
  assert.equal(q.total, 4500);
  const detail = await call('GET', `/quotes/${q.id}`);
  assert.equal(detail.customer_name, 'Evento Pérez');
  assert.equal(detail.status, 'pendiente');
  assert.ok(detail.valid_until);
  assert.equal((await call('GET', `/products/${beer.id}`)).stock, beer.stock);
  assert.deepEqual((await call('GET', '/cash')).balances, cashBefore);

  // Editar
  await call('PUT', `/quotes/${q.id}`, { items: [{ product_id: beer.id, quantity: 6, unit_price: 1000 }] });
  assert.equal((await call('GET', `/quotes/${q.id}`)).total, 6000);

  // Imprimir
  const res = await fetch(`${base}/quotes/${q.id}/print`, { headers: { Cookie: cookie } });
  assert.match(await res.text(), /PRESUPUESTO N° 0*\d+/);

  // Pasar a venta
  const sale = await call('POST', '/sales', {
    quote_id: q.id,
    items: [{ product_id: beer.id, quantity: 6, unit_price: 1000 }],
    paid_cash: 6000,
  });
  const after = await call('GET', `/quotes/${q.id}`);
  assert.equal(after.status, 'vendido');
  assert.equal(after.sale_id, sale.id);
  assert.equal((await call('GET', `/products/${beer.id}`)).stock, beer.stock - 6);
  await assert.rejects(call('POST', '/sales', { quote_id: q.id, items: [{ product_id: beer.id, quantity: 1 }], paid_cash: 9999 }), /vendido/);
  await assert.rejects(call('PUT', `/quotes/${q.id}`, { items: [{ product_id: beer.id, quantity: 1 }] }), /vendido/);

  // Anular la venta deja el presupuesto pendiente otra vez
  await call('POST', `/sales/${sale.id}/cancel`);
  assert.equal((await call('GET', `/quotes/${q.id}`)).status, 'pendiente');
  await call('POST', `/quotes/${q.id}/cancel`);
  assert.equal((await call('GET', '/quotes?status=anulado')).length, 1);
});

test('PDF reales de presupuesto, venta y lista de precios', async () => {
  const lists = await call('GET', '/price-lists');
  const quotes = await call('GET', '/quotes');
  const sales = await call('GET', '/sales');
  for (const url of [`/quotes/${quotes[0].id}/pdf`, `/sales/${sales[0].id}/pdf`, `/price-lists/${lists[0].id}/export.pdf`, `/price-lists/${lists[0].id}/export.pdf?layout=catalogo`]) {
    const res = await fetch(base + url, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-', url);
  }
  assert.equal((await call('GET', '/branding')).business_name, 'ETL Bebidas');
});

test('remitos X: numeración correlativa, uno por venta, PDF y anulación', async () => {
  const beer = await call('GET', '/products/barcode/111');
  await call('PUT', '/settings', { remito_pv: 2, remito_next: 150 });
  const s1 = await call('POST', '/sales', { items: [{ product_id: beer.id, quantity: 2 }], paid_cash: 99999 });
  const stockAfterSale = (await call('GET', `/products/${beer.id}`)).stock;
  const r1 = await call('POST', '/remitos', { sale_id: s1.id, delivery_address: 'San Martín 100', valued: false });
  assert.equal(r1.code, '0002-00000150');
  assert.equal((await call('GET', `/products/${beer.id}`)).stock, stockAfterSale); // no mueve stock
  await assert.rejects(call('POST', '/remitos', { sale_id: s1.id }), /ya tiene el remito/);
  const s2 = await call('POST', '/sales', { items: [{ product_id: beer.id, quantity: 1 }], paid_cash: 99999 });
  const r2 = await call('POST', '/remitos', { sale_id: s2.id });
  assert.equal(r2.code, '0002-00000151');
  assert.equal((await call('GET', `/remitos/${r1.id}`)).valued, 0);
  const res = await fetch(`${base}/remitos/${r1.id}/pdf`, { headers: { Cookie: cookie } });
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  // Anular la venta anula su remito; luego se puede emitir uno nuevo en otra venta
  await call('POST', `/sales/${s2.id}/cancel`);
  assert.equal((await call('GET', `/remitos/${r2.id}`)).status, 'anulado');
  await call('POST', `/remitos/${r1.id}/cancel`);
  const again = await call('POST', '/remitos', { sale_id: s1.id });
  assert.equal(again.code, '0002-00000152');
  const list = await call('GET', '/sales');
  assert.equal(list.find((x) => x.id === s1.id).remito_id, again.id);
});

test('historial y reportes mes a mes', async () => {
  const d = new Date().toLocaleDateString('sv-SE');
  const month = d.slice(0, 7);
  await call('POST', '/cash/movements', { box: 'efectivo', amount: 1000, concept: 'Flete', type: 'egreso' });

  const h = await call('GET', `/history?from=${month}-01&to=${d}`);
  const kinds = new Set(h.rows.map((r) => r.kind));
  for (const k of ['venta', 'compra', 'cobro', 'gasto', 'presupuesto', 'remito', 'traspaso']) assert.ok(kinds.has(k), `falta ${k}`);
  const onlyExpenses = await call('GET', `/history?from=${month}-01&to=${d}&kind=gasto&q=flete`);
  assert.ok(onlyExpenses.rows.length >= 1 && onlyExpenses.rows.every((r) => r.kind === 'gasto'));
  const voided = await call('GET', `/history?from=${month}-01&to=${d}&status=anuladas`);
  assert.ok(voided.rows.every((r) => ['anulada', 'anulado'].includes(r.status)));

  const m = await call('GET', `/reports/monthly?from_month=${month}&to_month=${month}`);
  assert.equal(m.months.length, 1);
  const cur = m.months[0];
  const sales = (await call('GET', `/sales?from=${month}-01&to=${d}&status=ok`)).reduce((a, s) => a + s.total, 0);
  assert.equal(cur.ventas, Math.round(sales * 100) / 100);
  assert.equal(cur.ganancia_bruta, Math.round((cur.ventas - cur.costo) * 100) / 100);
  assert.equal(cur.ganancia_neta, Math.round((cur.ganancia_bruta - cur.gastos) * 100) / 100);
  assert.ok(cur.gastos >= 1000);

  const p = await call('GET', `/reports/period?from=${month}-01&to=${d}`);
  assert.ok(p.products.length > 0 && p.expenses.some((e) => e.name === 'Flete'));
  for (const url of [`/history.xlsx?from=${month}-01`, '/reports/monthly.xlsx']) {
    const res = await fetch(base + url, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200, url);
  }
});

test('tienda online: desactivada por defecto, catálogo sin costos, pedido web y link personal', async () => {
  const pub = (path, opts = {}) => fetch(base + '/shop' + path, opts).then(async (r) => ({ status: r.status, data: await r.json() }));
  assert.equal((await pub('/info')).status, 403);

  const lists = await call('GET', '/price-lists');
  const mayorista = lists.find((l) => l.name === 'Mayorista');
  await call('PUT', '/settings', { shop_enabled: '1', shop_whatsapp: '5493510000000', shop_stock_mode: 'disponible', shop_min_order: '' });
  const info = await pub('/info');
  assert.equal(info.status, 200);
  assert.equal(info.data.show_prices, true);
  const products = (await pub('/products')).data;
  assert.ok(products.length > 0);
  assert.ok(products.every((p) => p.cost === undefined && p.stock === undefined), 'no expone costo ni stock exacto');
  const beer = products.find((p) => p.name === 'Cerveza 1L');
  assert.equal(beer.label, 'Disponible');

  const stockBefore = (await call('GET', `/products/${beer.id}`)).stock;
  const order = await pub('/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Juan', phone: '351 555', address: 'Calle 1', items: [{ product_id: beer.id, quantity: 3 }, { product_id: beer.id, quantity: 1 }], unit_price: 1 }),
  });
  assert.equal(order.status, 201);
  assert.match(order.data.whatsapp_url, /^https:\/\/wa\.me\/5493510000000\?text=/);
  assert.ok(decodeURIComponent(order.data.whatsapp_url).includes('4 x Cerveza 1L'));
  assert.equal(order.data.total, beer.price * 4); // el precio lo calcula el servidor
  const q = await call('GET', `/quotes/${order.data.id}`);
  assert.equal(q.source, 'web');
  assert.equal(q.customer_phone, '351 555');
  assert.equal((await call('GET', `/products/${beer.id}`)).stock, stockBefore); // no mueve stock
  assert.ok((await call('GET', '/quotes?source=web')).some((x) => x.id === order.data.id));
  assert.ok((await call('GET', '/shop/pending')).n >= 1);

  // Validaciones
  const bad = await pub('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X', phone: '1', items: [] }) });
  assert.equal(bad.status, 400);

  // Link personal: precios de la lista del cliente, sin pedir teléfono
  const { id: cid } = await call('POST', '/customers', { name: 'Kiosco Web', price_list_id: mayorista.id, phone: '351111' });
  const { token } = await call('POST', `/customers/${cid}/shop-link`, {});
  const personal = await pub(`/info?c=${token}`);
  assert.equal(personal.data.customer.name, 'Kiosco Web');
  const pBeer = (await pub(`/products?c=${token}`)).data.find((p) => p.id === beer.id);
  assert.equal(pBeer.price, 1300); // precio fijo mayorista
  const o2 = await pub('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ c: token, items: [{ product_id: beer.id, quantity: 2 }] }) });
  assert.equal(o2.status, 201);
  assert.equal((await call('GET', `/quotes/${o2.data.id}`)).customer_id, cid);
  assert.equal((await pub('/info?c=token-falso')).status, 404);

  // Modo privado
  await call('PUT', '/settings', { shop_private: '1' });
  assert.equal((await pub('/info')).status, 403);
  assert.equal((await pub(`/info?c=${token}`)).status, 200);
  await call('PUT', '/settings', { shop_private: '0', shop_enabled: '0' });
});

test('borrar lista de precios, producto o cliente que ya se usaron no da error de clave foránea', async () => {
  const list = await call('POST', '/price-lists', { name: 'Temporal FK', markup: 10 });
  const prod = await call('POST', '/products', { name: 'Producto FK', cost: 100, stock: 5 });
  const cli = await call('POST', '/customers', { name: 'Cliente FK', price_list_id: list.id });
  await call('POST', '/quotes', { customer_id: cli.id, price_list_id: list.id, items: [{ product_id: prod.id, quantity: 1 }] });
  const sale = await call('POST', '/sales', { price_list_id: list.id, items: [{ product_id: prod.id, quantity: 1, unit_price: 777 }], paid_cash: 777 });

  await call('DELETE', `/price-lists/${list.id}`);
  assert.ok(!(await call('GET', '/price-lists')).some((l) => l.id === list.id));
  const s = await call('GET', `/sales/${sale.id}`);
  assert.equal(s.items[0].unit_price, 777); // el precio cobrado no cambia
  assert.equal((await call('GET', `/customers/${cli.id}`)).price_list_id, null);

  assert.equal((await call('DELETE', `/customers/${cli.id}`)).deactivated, true);
  assert.equal((await call('DELETE', `/products/${prod.id}`)).deactivated, true);
});

test('pedidos web: no se puede pedir más que el stock, la mercadería queda reservada y se libera al cancelar', async () => {
  await call('PUT', '/settings', { shop_enabled: '1', shop_private: '0', shop_whatsapp: '5493510000000', shop_min_order: '' });
  const pub = (path, body) =>
    fetch(base + '/shop' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then(async (r) => ({ status: r.status, data: await r.json() }));
  const prod = await call('POST', '/products', { name: 'Reserva Test', cost: 100, stock: 10 });
  const find = async () => (await pub('/products')).data.find((p) => p.id === prod.id);
  assert.equal((await find()).max, 10);

  // Más de lo que hay: rechazado
  const tooMuch = await pub('/orders', { name: 'Ana', phone: '1', items: [{ product_id: prod.id, quantity: 11 }] });
  assert.equal(tooMuch.status, 409);
  assert.match(tooMuch.data.error, /solo hay 10 disponibles/);

  // Pedido de 7: quedan 3 disponibles para el resto
  const o1 = await pub('/orders', { name: 'Ana', phone: '1', items: [{ product_id: prod.id, quantity: 7 }] });
  assert.equal(o1.status, 201);
  assert.equal((await find()).max, 3);
  const catalog = (await call('GET', '/products?q=Reserva Test'))[0];
  assert.equal(catalog.stock, 10); // el stock real no cambia
  assert.equal(catalog.reserved, 7);
  assert.equal(catalog.available, 3);
  assert.equal((await pub('/orders', { name: 'Beto', phone: '2', items: [{ product_id: prod.id, quantity: 4 }] })).status, 409);
  const o2 = await pub('/orders', { name: 'Beto', phone: '2', items: [{ product_id: prod.id, quantity: 3 }] });
  assert.equal(o2.status, 201);
  assert.equal((await find()).available, false);

  // Estados
  await call('POST', `/quotes/${o1.data.id}/status`, { status: 'confirmado' });
  await call('POST', `/quotes/${o1.data.id}/status`, { status: 'listo' });
  assert.equal((await call('GET', `/quotes/${o1.data.id}`)).status, 'listo');
  await assert.rejects(call('POST', `/quotes/${o1.data.id}/status`, { status: 'vendido' }), /inválido/);
  assert.equal((await call('GET', '/quotes?status=activos&source=web')).filter((q) => [o1.data.id, o2.data.id].includes(q.id)).length, 2);

  // Modificar: no puede superar lo disponible (su propia reserva cuenta a favor)
  const q1 = await call('GET', `/quotes/${o1.data.id}`);
  assert.equal(q1.items[0].available, 7);
  await assert.rejects(call('PUT', `/quotes/${o1.data.id}`, { items: [{ product_id: prod.id, quantity: 8, unit_price: 100 }] }), /solo hay 7/);
  await call('PUT', `/quotes/${o1.data.id}`, { customer_name: 'Ana', items: [{ product_id: prod.id, quantity: 5, unit_price: 100 }] });
  assert.equal((await call('GET', `/quotes/${o1.data.id}`)).status, 'modificado');
  assert.equal((await find()).max, 2);

  // Cancelar libera la reserva
  await call('POST', `/quotes/${o2.data.id}/cancel`);
  assert.equal((await find()).max, 5);

  // Cobrar y cerrar: descuenta stock y libera la reserva
  const sale = await call('POST', '/sales', { quote_id: o1.data.id, items: [{ product_id: prod.id, quantity: 5, unit_price: 100 }], paid_cash: 500 });
  const closed = await call('GET', `/quotes/${o1.data.id}`);
  assert.equal(closed.status, 'vendido');
  assert.equal(closed.sale_id, sale.id);
  const after = (await call('GET', '/products?q=Reserva Test'))[0];
  assert.equal(after.stock, 5);
  assert.equal(after.reserved, 0);
  assert.equal((await find()).max, 5);
  await call('PUT', '/settings', { shop_enabled: '0' });
});
