const path = require('path');
const fs = require('fs');
const { db, round2, UPLOADS_DIR } = require('./db');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const BOXES = ['efectivo', 'transferencia'];

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

const DEFAULT_LOGO = path.join(__dirname, '..', 'public', 'img', 'logo.jpg');

/** Archivo del logo: el subido en Configuración, o el logo de ETL Bebidas incluido en el sistema. */
function logoFile() {
  const uploaded = getSetting('logo');
  if (uploaded) {
    const f = path.join(UPLOADS_DIR, path.basename(uploaded));
    if (fs.existsSync(f)) return f;
  }
  return fs.existsSync(DEFAULT_LOGO) ? DEFAULT_LOGO : null;
}

/**
 * Pedidos web en curso: su mercadería queda reservada (no se puede vender a otro)
 * hasta que se cierra la venta o se cancela el pedido.
 */
const ORDER_ACTIVE = ['pendiente', 'confirmado', 'listo', 'modificado'];
const ORDER_ACTIVE_SQL = ORDER_ACTIVE.map((s) => `'${s}'`).join(',');

/** Cantidad reservada por producto. excludeQuoteId permite no contar la reserva del propio pedido. */
function reservedMap(excludeQuoteId = -1) {
  const rows = db
    .prepare(
      `SELECT i.product_id, SUM(i.quantity) qty FROM quote_items i JOIN quotes q ON q.id = i.quote_id
       WHERE q.source = 'web' AND q.status IN (${ORDER_ACTIVE_SQL}) AND q.id <> ? AND i.product_id IS NOT NULL
       GROUP BY i.product_id`
    )
    .all(excludeQuoteId);
  return new Map(rows.map((r) => [r.product_id, r.qty]));
}

/** Verifica que haya stock disponible (stock − reservado) para cada línea. lines: [{ product, qty }] */
function assertAvailable(lines, excludeQuoteId) {
  const reserved = reservedMap(excludeQuoteId);
  const merged = new Map();
  for (const l of lines) if (l.product) merged.set(l.product.id, { p: l.product, qty: (merged.get(l.product.id)?.qty || 0) + l.qty });
  const problems = [];
  for (const { p, qty } of merged.values()) {
    const available = Math.max(0, Math.round((p.stock - (reserved.get(p.id) || 0)) * 100) / 100);
    if (qty > available + 1e-9) problems.push(available > 0 ? `${p.name}: solo hay ${available} disponibles` : `${p.name}: sin stock disponible`);
  }
  if (problems.length) throw new HttpError(409, problems.join(' · '));
}

function defaultPriceListId() {
  const row = db.prepare('SELECT id FROM price_lists ORDER BY is_default DESC, id ASC LIMIT 1').get();
  return row ? row.id : null;
}

function getPriceList(id) {
  const list = db.prepare('SELECT * FROM price_lists WHERE id = ?').get(id);
  if (!list) throw new HttpError(404, 'Lista de precios no encontrada');
  return list;
}

/** Precio de un producto en una lista: precio fijo cargado, o costo + recargo de la lista. */
function priceFor(product, list) {
  const fixed = db
    .prepare('SELECT price FROM product_prices WHERE product_id = ? AND price_list_id = ?')
    .get(product.id, list.id);
  if (fixed) return { price: fixed.price, fixed: true };
  return { price: round2(product.cost * (1 + list.markup / 100)), fixed: false };
}

/** Todos los precios de un producto (uno por lista). */
function pricesForProduct(product) {
  const lists = db.prepare('SELECT * FROM price_lists ORDER BY id').all();
  return lists.map((l) => ({ price_list_id: l.id, name: l.name, ...priceFor(product, l) }));
}

function addCash(box, amount, concept, refType, refId, date) {
  if (!BOXES.includes(box)) throw new HttpError(400, 'Caja inválida');
  amount = round2(amount);
  if (amount === 0) return;
  db.prepare(
    `INSERT INTO cash_movements (box, amount, concept, ref_type, ref_id, date)
     VALUES (?,?,?,?,?, COALESCE(?, datetime('now','localtime')))`
  ).run(box, amount, concept, refType || 'manual', refId || null, date || null);
}

function addAccount(partyType, partyId, amount, concept, refType, refId, date) {
  amount = round2(amount);
  if (amount === 0) return;
  db.prepare(
    `INSERT INTO account_movements (party_type, party_id, amount, concept, ref_type, ref_id, date)
     VALUES (?,?,?,?,?,?, COALESCE(?, datetime('now','localtime')))`
  ).run(partyType, partyId, amount, concept, refType || null, refId || null, date || null);
}

function addStock(productId, quantity, type, refId, notes) {
  if (!quantity) return;
  db.prepare('UPDATE products SET stock = stock + ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(
    quantity,
    productId
  );
  db.prepare('INSERT INTO stock_movements (product_id, quantity, type, ref_id, notes) VALUES (?,?,?,?,?)').run(
    productId,
    quantity,
    type,
    refId || null,
    notes || null
  );
}

function boxBalances() {
  const rows = db.prepare('SELECT box, COALESCE(SUM(amount),0) balance FROM cash_movements GROUP BY box').all();
  const out = { efectivo: 0, transferencia: 0 };
  rows.forEach((r) => (out[r.box] = round2(r.balance)));
  out.total = round2(out.efectivo + out.transferencia);
  return out;
}

function accountBalance(partyType, partyId) {
  const r = db
    .prepare('SELECT COALESCE(SUM(amount),0) b FROM account_movements WHERE party_type = ? AND party_id = ?')
    .get(partyType, partyId);
  return round2(r.b);
}

module.exports = {
  ORDER_ACTIVE,
  ORDER_ACTIVE_SQL,
  reservedMap,
  assertAvailable,
  HttpError,
  BOXES,
  getSetting,
  logoFile,
  defaultPriceListId,
  getPriceList,
  priceFor,
  pricesForProduct,
  addCash,
  addAccount,
  addStock,
  boxBalances,
  accountBalance,
};
