const express = require('express');
const { db, round2 } = require('../db');
const { HttpError, addCash, addAccount, accountBalance, BOXES } = require('../services');
const { emptyToNull, num } = require('./catalog');

/**
 * Rutas de clientes y proveedores (comparten la misma lógica de cuenta corriente).
 * Cuenta corriente: saldo > 0 significa que el cliente nos debe / que le debemos al proveedor.
 */
function partyRouter({ table, partyType, label }) {
  const router = express.Router();
  const isCustomer = partyType === 'cliente';

  const balanceSql = `(SELECT COALESCE(SUM(amount),0) FROM account_movements a WHERE a.party_type = '${partyType}' AND a.party_id = t.id)`;

  router.get('/', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.include_inactive !== '1') where.push('t.active = 1');
    if (req.query.q) {
      where.push('(t.name LIKE ? OR t.tax_id LIKE ? OR t.phone LIKE ?)');
      params.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`);
    }
    if (req.query.with_balance === '1') where.push(`ABS(${balanceSql}) > 0.004`);
    const extra = isCustomer
      ? ', pl.name price_list_name FROM customers t LEFT JOIN price_lists pl ON pl.id = t.price_list_id'
      : ` FROM ${table} t`;
    const rows = db
      .prepare(
        `SELECT t.*, ROUND(${balanceSql}, 2) balance ${extra} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.name`
      )
      .all(...params);
    res.json(rows);
  });

  router.get('/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) throw new HttpError(404, `${label} no encontrado`);
    row.balance = accountBalance(partyType, row.id);
    res.json(row);
  });

  function fields(body) {
    const name = emptyToNull(body.name);
    if (!name) throw new HttpError(400, 'El nombre es obligatorio');
    const f = {
      name,
      tax_id: emptyToNull(body.tax_id),
      phone: emptyToNull(body.phone),
      email: emptyToNull(body.email),
      address: emptyToNull(body.address),
      notes: emptyToNull(body.notes),
      active: body.active === undefined || body.active === true || body.active === 1 || body.active === '1' ? 1 : 0,
    };
    if (isCustomer) {
      f.price_list_id = body.price_list_id ? Number(body.price_list_id) : null;
      f.credit_limit = round2(num(body.credit_limit));
    }
    return f;
  }

  router.post('/', (req, res) => {
    const f = fields(req.body);
    const cols = Object.keys(f);
    const r = db
      .prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`)
      .run(f);
    const id = r.lastInsertRowid;
    const opening = round2(num(req.body.opening_balance));
    if (opening) addAccount(partyType, id, opening, 'Saldo inicial', 'inicial');
    res.status(201).json({ id });
  });

  router.put('/:id', (req, res) => {
    const f = fields(req.body);
    const cols = Object.keys(f);
    const r = db
      .prepare(`UPDATE ${table} SET ${cols.map((c) => `${c}=@${c}`).join(',')} WHERE id=@id`)
      .run({ ...f, id: req.params.id });
    if (!r.changes) throw new HttpError(404, `${label} no encontrado`);
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const hasHistory =
      db.prepare('SELECT 1 FROM account_movements WHERE party_type = ? AND party_id = ? LIMIT 1').get(partyType, id) ||
      db.prepare(`SELECT 1 FROM ${isCustomer ? 'sales WHERE customer_id' : 'purchases WHERE supplier_id'} = ? LIMIT 1`).get(id);
    if (hasHistory) {
      db.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).run(id);
      return res.json({ ok: true, deactivated: true });
    }
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    res.json({ ok: true });
  });

  /** Movimientos de cuenta corriente con saldo acumulado. */
  router.get('/:id/account', (req, res) => {
    const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!party) throw new HttpError(404, `${label} no encontrado`);
    const movs = db
      .prepare('SELECT * FROM account_movements WHERE party_type = ? AND party_id = ? ORDER BY date, id')
      .all(partyType, party.id);
    let running = 0;
    movs.forEach((m) => {
      running = round2(running + m.amount);
      m.balance = running;
    });
    res.json({ party, balance: running, movements: movs.reverse() });
  });

  /**
   * Registrar un pago a cuenta corriente.
   * Cliente: cobro -> entra dinero a la caja y baja la deuda.
   * Proveedor: pago -> sale dinero de la caja y baja lo que le debemos.
   * También permite ajustes (nota de débito/crédito) sin mover caja: box = 'ninguna'.
   */
  router.post('/:id/payments', (req, res) => {
    const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!party) throw new HttpError(404, `${label} no encontrado`);
    const amount = round2(num(req.body.amount));
    if (amount <= 0) throw new HttpError(400, 'El importe debe ser mayor a cero');
    const box = req.body.box;
    const kind = req.body.kind || 'pago'; // pago | ajuste_debe | ajuste_haber
    const concept =
      emptyToNull(req.body.concept) ||
      (kind === 'pago' ? (isCustomer ? 'Cobro' : 'Pago') : kind === 'ajuste_debe' ? 'Ajuste (aumenta deuda)' : 'Ajuste (reduce deuda)');
    db.transaction(() => {
      if (kind === 'pago') {
        if (!BOXES.includes(box)) throw new HttpError(400, 'Elegí la caja: efectivo o transferencia');
        addAccount(partyType, party.id, -amount, `${concept} (${box})`, isCustomer ? 'cobro' : 'pago');
        addCash(box, isCustomer ? amount : -amount, `${concept} - ${party.name}`, isCustomer ? 'cobro' : 'pago', party.id);
      } else if (kind === 'ajuste_debe') {
        addAccount(partyType, party.id, amount, concept, 'ajuste');
      } else if (kind === 'ajuste_haber') {
        addAccount(partyType, party.id, -amount, concept, 'ajuste');
      } else throw new HttpError(400, 'Tipo de movimiento inválido');
    })();
    res.status(201).json({ ok: true, balance: accountBalance(partyType, party.id) });
  });

  return router;
}

module.exports = {
  customers: partyRouter({ table: 'customers', partyType: 'cliente', label: 'Cliente' }),
  suppliers: partyRouter({ table: 'suppliers', partyType: 'proveedor', label: 'Proveedor' }),
};
