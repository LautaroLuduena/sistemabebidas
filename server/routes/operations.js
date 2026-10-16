const express = require('express');
const { db, round2 } = require('../db');
const {
  HttpError,
  getPriceList,
  priceFor,
  defaultPriceListId,
  addCash,
  addAccount,
  addStock,
  getSetting,
} = require('../services');
const { emptyToNull, num } = require('./catalog');

function dateFilters(req, column, where, params) {
  if (req.query.from) {
    where.push(`date(${column}) >= date(?)`);
    params.push(req.query.from);
  }
  if (req.query.to) {
    where.push(`date(${column}) <= date(?)`);
    params.push(req.query.to);
  }
}

/** Reparte lo pagado entre efectivo / transferencia / cuenta corriente. El exceso en efectivo es vuelto. */
function splitPayment(total, paidCash, paidTransfer) {
  paidCash = round2(Math.max(0, num(paidCash)));
  paidTransfer = round2(Math.max(0, num(paidTransfer)));
  if (paidTransfer > total + 0.004) throw new HttpError(400, 'La transferencia supera el total');
  let change = 0;
  if (paidCash + paidTransfer > total + 0.004) {
    change = round2(paidCash + paidTransfer - total);
    paidCash = round2(paidCash - change);
  }
  const onAccount = round2(total - paidCash - paidTransfer);
  return { paidCash, paidTransfer, onAccount, change };
}

// =================== VENTAS ===================
const sales = express.Router();

sales.get('/', (req, res) => {
  const where = [];
  const params = [];
  dateFilters(req, 's.date', where, params);
  if (req.query.customer_id) {
    where.push('s.customer_id = ?');
    params.push(req.query.customer_id);
  }
  if (req.query.status) {
    where.push('s.status = ?');
    params.push(req.query.status);
  }
  const rows = db
    .prepare(
      `SELECT s.*, c.name customer_name, pl.name price_list_name,
              (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) items,
              (SELECT r.id FROM remitos r WHERE r.sale_id = s.id AND r.status = 'emitido' ORDER BY r.id DESC LIMIT 1) remito_id
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN price_lists pl ON pl.id = s.price_list_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT ?`
    )
    .all(...params, Math.min(num(req.query.limit, 300), 5000));
  res.json(rows);
});

function getSale(id) {
  const sale = db
    .prepare(
      `SELECT s.*, c.name customer_name, c.tax_id customer_tax_id, c.address customer_address, pl.name price_list_name
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN price_lists pl ON pl.id = s.price_list_id
       WHERE s.id = ?`
    )
    .get(id);
  if (!sale) throw new HttpError(404, 'Venta no encontrada');
  sale.items = db
    .prepare(
      `SELECT i.*, p.code, p.barcode, p.units_per_pack FROM sale_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.sale_id = ? ORDER BY i.id`
    )
    .all(id);
  sale.remito = db.prepare("SELECT id, pv, number FROM remitos WHERE sale_id = ? AND status = 'emitido' ORDER BY id DESC").get(id) || null;
  return sale;
}

sales.get('/:id', (req, res) => res.json(getSale(req.params.id)));

/**
 * Arma las líneas de un comprobante de venta o presupuesto: resuelve cliente, lista de precios,
 * precio de cada producto (o el precio indicado), subtotal, descuento y total.
 */
function buildLines(body, what) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, `${what} no tiene productos`);
  const customer = body.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(body.customer_id) : null;
  if (body.customer_id && !customer) throw new HttpError(404, 'Cliente no encontrado');
  const list = getPriceList(body.price_list_id || (customer && customer.price_list_id) || defaultPriceListId());

  const lines = items.map((it) => {
    const qty = num(it.quantity);
    if (qty <= 0) throw new HttpError(400, 'Las cantidades deben ser mayores a cero');
    if (it.product_id) {
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
      if (!p) throw new HttpError(404, `Producto ${it.product_id} no encontrado`);
      const unit = it.unit_price === undefined || it.unit_price === '' ? priceFor(p, list).price : round2(it.unit_price);
      return { product: p, description: p.name, qty, unit, cost: p.cost, subtotal: round2(qty * unit) };
    }
    // Ítem libre (sin producto de inventario)
    const description = emptyToNull(it.description);
    if (!description) throw new HttpError(400, 'Ítem sin descripción');
    const unit = round2(it.unit_price);
    return { product: null, description, qty, unit, cost: 0, subtotal: round2(qty * unit) };
  });

  const subtotal = round2(lines.reduce((a, l) => a + l.subtotal, 0));
  const discount = round2(Math.max(0, num(body.discount)));
  if (discount > subtotal) throw new HttpError(400, 'El descuento supera el subtotal');
  return { customer, list, lines, subtotal, discount, total: round2(subtotal - discount) };
}

sales.post('/', (req, res) => {
  const body = req.body || {};
  const { customer, list, lines, subtotal, discount, total } = buildLines(body, 'La venta');
  const quote = body.quote_id ? db.prepare('SELECT * FROM quotes WHERE id = ?').get(body.quote_id) : null;
  if (body.quote_id && !quote) throw new HttpError(404, 'Presupuesto no encontrado');
  if (quote && quote.status !== 'pendiente') throw new HttpError(400, `El presupuesto #${quote.id} ya está ${quote.status}`);
  const pay = splitPayment(total, body.paid_cash, body.paid_transfer);
  if (pay.onAccount > 0.004 && !customer)
    throw new HttpError(400, 'Para dejar saldo en cuenta corriente tenés que elegir un cliente');

  const id = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO sales (customer_id, price_list_id, subtotal, discount, total, paid_cash, paid_transfer, on_account, notes)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        customer ? customer.id : null,
        list.id,
        subtotal,
        discount,
        total,
        pay.paidCash,
        pay.paidTransfer,
        pay.onAccount,
        emptyToNull(body.notes)
      );
    const saleId = r.lastInsertRowid;
    const insItem = db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, description, quantity, unit_price, unit_cost, subtotal) VALUES (?,?,?,?,?,?,?)`
    );
    for (const l of lines) {
      insItem.run(saleId, l.product ? l.product.id : null, l.description, l.qty, l.unit, l.cost, l.subtotal);
      if (l.product) addStock(l.product.id, -l.qty, 'venta', saleId);
    }
    const who = customer ? ` - ${customer.name}` : '';
    addCash('efectivo', pay.paidCash, `Venta #${saleId}${who}`, 'venta', saleId);
    addCash('transferencia', pay.paidTransfer, `Venta #${saleId}${who}`, 'venta', saleId);
    if (customer) addAccount('cliente', customer.id, pay.onAccount, `Venta #${saleId} (a cuenta)`, 'venta', saleId);
    if (quote) db.prepare("UPDATE quotes SET status = 'vendido', sale_id = ? WHERE id = ?").run(saleId, quote.id);
    return saleId;
  })();

  res.status(201).json({ id, total, change: pay.change, on_account: pay.onAccount });
});

sales.post('/:id/cancel', (req, res) => {
  const sale = getSale(req.params.id);
  if (sale.status === 'anulada') throw new HttpError(400, 'La venta ya está anulada');
  db.transaction(() => {
    db.prepare("UPDATE sales SET status = 'anulada' WHERE id = ?").run(sale.id);
    for (const it of sale.items) if (it.product_id) addStock(it.product_id, it.quantity, 'anulacion', sale.id, `Anulación venta #${sale.id}`);
    addCash('efectivo', -sale.paid_cash, `Anulación venta #${sale.id}`, 'venta', sale.id);
    addCash('transferencia', -sale.paid_transfer, `Anulación venta #${sale.id}`, 'venta', sale.id);
    if (sale.customer_id) addAccount('cliente', sale.customer_id, -sale.on_account, `Anulación venta #${sale.id}`, 'venta', sale.id);
    // Los remitos de la venta quedan anulados
    db.prepare("UPDATE remitos SET status = 'anulado' WHERE sale_id = ?").run(sale.id);
    // Si la venta salió de un presupuesto, el presupuesto vuelve a quedar pendiente
    db.prepare("UPDATE quotes SET status = 'pendiente', sale_id = NULL WHERE sale_id = ?").run(sale.id);
  })();
  res.json({ ok: true });
});

// =================== PRESUPUESTOS ===================
const quotes = express.Router();

quotes.get('/', (req, res) => {
  const where = [];
  const params = [];
  dateFilters(req, 'q.date', where, params);
  if (req.query.customer_id) {
    where.push('q.customer_id = ?');
    params.push(req.query.customer_id);
  }
  if (req.query.status) {
    where.push('q.status = ?');
    params.push(req.query.status);
  }
  const rows = db
    .prepare(
      `SELECT q.*, COALESCE(c.name, q.customer_name) customer_name, pl.name price_list_name,
              (SELECT COUNT(*) FROM quote_items i WHERE i.quote_id = q.id) items
       FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id LEFT JOIN price_lists pl ON pl.id = q.price_list_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY q.id DESC LIMIT ?`
    )
    .all(...params, Math.min(num(req.query.limit, 300), 5000));
  res.json(rows);
});

function getQuote(id) {
  const q = db
    .prepare(
      `SELECT q.*, COALESCE(c.name, q.customer_name) customer_name, c.tax_id customer_tax_id, c.address customer_address,
              c.phone customer_phone, pl.name price_list_name
       FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id LEFT JOIN price_lists pl ON pl.id = q.price_list_id
       WHERE q.id = ?`
    )
    .get(id);
  if (!q) throw new HttpError(404, 'Presupuesto no encontrado');
  q.items = db
    .prepare(
      `SELECT i.*, p.code, p.barcode, p.stock, p.image, p.units_per_pack FROM quote_items i
       LEFT JOIN products p ON p.id = i.product_id WHERE i.quote_id = ? ORDER BY i.id`
    )
    .all(id);
  return q;
}

quotes.get('/:id', (req, res) => res.json(getQuote(req.params.id)));

function saveQuote(body, id) {
  const { customer, list, lines, subtotal, discount, total } = buildLines(body, 'El presupuesto');
  const validDays = Math.max(0, Math.round(num(body.valid_days, num(getSetting('quote_valid_days'), 7))));
  const fields = [
    customer ? customer.id : null,
    customer ? null : emptyToNull(body.customer_name),
    list.id,
    subtotal,
    discount,
    total,
    validDays ? new Date(Date.now() + validDays * 864e5).toLocaleDateString('sv-SE') : null,
    emptyToNull(body.notes),
  ];
  return db.transaction(() => {
    if (id) {
      db.prepare(
        `UPDATE quotes SET customer_id=?, customer_name=?, price_list_id=?, subtotal=?, discount=?, total=?, valid_until=?, notes=? WHERE id=?`
      ).run(...fields, id);
      db.prepare('DELETE FROM quote_items WHERE quote_id = ?').run(id);
    } else {
      id = db
        .prepare(
          `INSERT INTO quotes (customer_id, customer_name, price_list_id, subtotal, discount, total, valid_until, notes) VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(...fields).lastInsertRowid;
    }
    const ins = db.prepare(
      'INSERT INTO quote_items (quote_id, product_id, description, quantity, unit_price, subtotal) VALUES (?,?,?,?,?,?)'
    );
    for (const l of lines) ins.run(id, l.product ? l.product.id : null, l.description, l.qty, l.unit, l.subtotal);
    return { id, total };
  })();
}

quotes.post('/', (req, res) => res.status(201).json(saveQuote(req.body)));

quotes.put('/:id', (req, res) => {
  const q = getQuote(req.params.id);
  if (q.status !== 'pendiente') throw new HttpError(400, `El presupuesto ya está ${q.status}; no se puede modificar`);
  res.json(saveQuote(req.body, q.id));
});

quotes.post('/:id/cancel', (req, res) => {
  const q = getQuote(req.params.id);
  if (q.status !== 'pendiente') throw new HttpError(400, `El presupuesto ya está ${q.status}`);
  db.prepare("UPDATE quotes SET status = 'anulado' WHERE id = ?").run(q.id);
  res.json({ ok: true });
});

// =================== REMITOS X ===================
const remitos = express.Router();
const fmtRemito = (r) => `${String(r.pv).padStart(4, '0')}-${String(r.number).padStart(8, '0')}`;

const REMITO_SELECT = `SELECT r.*, s.total, s.status sale_status, s.customer_id, c.name customer_name, c.tax_id customer_tax_id,
    c.phone customer_phone, c.address customer_address
  FROM remitos r JOIN sales s ON s.id = r.sale_id LEFT JOIN customers c ON c.id = s.customer_id`;

remitos.get('/', (req, res) => {
  const where = [];
  const params = [];
  dateFilters(req, 'r.date', where, params);
  if (req.query.customer_id) {
    where.push('s.customer_id = ?');
    params.push(req.query.customer_id);
  }
  if (req.query.status) {
    where.push('r.status = ?');
    params.push(req.query.status);
  }
  const rows = db
    .prepare(`${REMITO_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT ?`)
    .all(...params, Math.min(num(req.query.limit, 300), 5000));
  rows.forEach((r) => (r.code = fmtRemito(r)));
  res.json(rows);
});

function getRemito(id) {
  const r = db.prepare(`${REMITO_SELECT} WHERE r.id = ?`).get(id);
  if (!r) throw new HttpError(404, 'Remito no encontrado');
  r.code = fmtRemito(r);
  r.sale = getSale(r.sale_id);
  return r;
}

remitos.get('/:id', (req, res) => res.json(getRemito(req.params.id)));

/** Emite un remito para una venta. El número es correlativo por punto de venta. */
remitos.post('/', (req, res) => {
  const sale = getSale(req.body.sale_id);
  if (sale.status === 'anulada') throw new HttpError(400, 'La venta está anulada');
  if (sale.remito && !req.body.force)
    throw new HttpError(409, `La venta #${sale.id} ya tiene el remito ${fmtRemito(sale.remito)}`);
  const pv = Math.max(1, Math.round(num(getSetting('remito_pv'), 1)));
  const id = db.transaction(() => {
    const max = db.prepare('SELECT COALESCE(MAX(number), 0) m FROM remitos WHERE pv = ?').get(pv).m;
    const number = Math.max(max + 1, Math.round(num(getSetting('remito_next'), 1)));
    const valued = req.body.valued === undefined ? getSetting('remito_valued') !== '0' : Boolean(req.body.valued);
    const r = db
      .prepare('INSERT INTO remitos (pv, number, sale_id, delivery_address, notes, valued) VALUES (?,?,?,?,?,?)')
      .run(pv, number, sale.id, emptyToNull(req.body.delivery_address) || sale.customer_address || null, emptyToNull(req.body.notes), valued ? 1 : 0);
    db.prepare("INSERT INTO settings (key, value) VALUES ('remito_next', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      String(number + 1)
    );
    return r.lastInsertRowid;
  })();
  const r = getRemito(id);
  res.status(201).json({ id, code: r.code });
});

remitos.post('/:id/cancel', (req, res) => {
  const r = getRemito(req.params.id);
  if (r.status === 'anulado') throw new HttpError(400, 'El remito ya está anulado');
  db.prepare("UPDATE remitos SET status = 'anulado' WHERE id = ?").run(r.id);
  res.json({ ok: true });
});

// =================== COMPRAS ===================
const purchases = express.Router();

purchases.get('/', (req, res) => {
  const where = [];
  const params = [];
  dateFilters(req, 'p.date', where, params);
  if (req.query.supplier_id) {
    where.push('p.supplier_id = ?');
    params.push(req.query.supplier_id);
  }
  const rows = db
    .prepare(
      `SELECT p.*, s.name supplier_name, (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = p.id) items
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT ?`
    )
    .all(...params, Math.min(num(req.query.limit, 300), 5000));
  res.json(rows);
});

function getPurchase(id) {
  const p = db
    .prepare('SELECT p.*, s.name supplier_name FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?')
    .get(id);
  if (!p) throw new HttpError(404, 'Compra no encontrada');
  p.items = db
    .prepare(
      `SELECT i.*, pr.code, pr.barcode FROM purchase_items i LEFT JOIN products pr ON pr.id = i.product_id WHERE i.purchase_id = ? ORDER BY i.id`
    )
    .all(id);
  return p;
}

purchases.get('/:id', (req, res) => res.json(getPurchase(req.params.id)));

purchases.post('/', (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, 'La compra no tiene productos');
  const supplier = body.supplier_id ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(body.supplier_id) : null;
  if (body.supplier_id && !supplier) throw new HttpError(404, 'Proveedor no encontrado');
  const updateCost = body.update_cost !== false;

  const lines = items.map((it) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
    if (!p) throw new HttpError(404, `Producto ${it.product_id} no encontrado`);
    const qty = num(it.quantity);
    if (qty <= 0) throw new HttpError(400, 'Las cantidades deben ser mayores a cero');
    const unit = it.unit_cost === undefined || it.unit_cost === '' ? p.cost : round2(it.unit_cost);
    return { product: p, qty, unit, subtotal: round2(qty * unit) };
  });
  const total = round2(lines.reduce((a, l) => a + l.subtotal, 0));
  const pay = splitPayment(total, body.paid_cash, body.paid_transfer);
  if (pay.change > 0) throw new HttpError(400, 'Lo pagado supera el total de la compra');
  if (pay.onAccount > 0.004 && !supplier)
    throw new HttpError(400, 'Para dejar saldo en cuenta corriente tenés que elegir un proveedor');

  const id = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO purchases (supplier_id, invoice_number, total, paid_cash, paid_transfer, on_account, notes, date)
         VALUES (?,?,?,?,?,?,?, COALESCE(?, datetime('now','localtime')))`
      )
      .run(
        supplier ? supplier.id : null,
        emptyToNull(body.invoice_number),
        total,
        pay.paidCash,
        pay.paidTransfer,
        pay.onAccount,
        emptyToNull(body.notes),
        emptyToNull(body.date)
      );
    const pid = r.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO purchase_items (purchase_id, product_id, description, quantity, unit_cost, subtotal) VALUES (?,?,?,?,?,?)'
    );
    for (const l of lines) {
      ins.run(pid, l.product.id, l.product.name, l.qty, l.unit, l.subtotal);
      addStock(l.product.id, l.qty, 'compra', pid);
      if (updateCost && l.unit > 0)
        db.prepare("UPDATE products SET cost = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(l.unit, l.product.id);
    }
    const who = supplier ? ` - ${supplier.name}` : '';
    addCash('efectivo', -pay.paidCash, `Compra #${pid}${who}`, 'compra', pid);
    addCash('transferencia', -pay.paidTransfer, `Compra #${pid}${who}`, 'compra', pid);
    if (supplier) {
      const inv = body.invoice_number ? ` Fact. ${body.invoice_number}` : '';
      addAccount('proveedor', supplier.id, pay.onAccount, `Compra #${pid}${inv} (a cuenta)`, 'compra', pid);
    }
    return pid;
  })();
  res.status(201).json({ id, total, on_account: pay.onAccount });
});

purchases.post('/:id/cancel', (req, res) => {
  const p = getPurchase(req.params.id);
  if (p.status === 'anulada') throw new HttpError(400, 'La compra ya está anulada');
  db.transaction(() => {
    db.prepare("UPDATE purchases SET status = 'anulada' WHERE id = ?").run(p.id);
    for (const it of p.items) if (it.product_id) addStock(it.product_id, -it.quantity, 'anulacion', p.id, `Anulación compra #${p.id}`);
    addCash('efectivo', p.paid_cash, `Anulación compra #${p.id}`, 'compra', p.id);
    addCash('transferencia', p.paid_transfer, `Anulación compra #${p.id}`, 'compra', p.id);
    if (p.supplier_id) addAccount('proveedor', p.supplier_id, -p.on_account, `Anulación compra #${p.id}`, 'compra', p.id);
  })();
  res.json({ ok: true });
});

module.exports = { sales, purchases, quotes, remitos, getSale, getQuote, getRemito, dateFilters, buildLines };
