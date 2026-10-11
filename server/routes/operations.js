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
              (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) items
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
      `SELECT i.*, p.code, p.barcode FROM sale_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.sale_id = ? ORDER BY i.id`
    )
    .all(id);
  return sale;
}

sales.get('/:id', (req, res) => res.json(getSale(req.params.id)));

sales.post('/', (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, 'La venta no tiene productos');
  const customer = body.customer_id
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(body.customer_id)
    : null;
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
  const total = round2(subtotal - discount);
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
  })();
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

module.exports = { sales, purchases, getSale, dateFilters };
