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
