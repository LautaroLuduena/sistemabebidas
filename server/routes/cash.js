const express = require('express');
const { db, round2 } = require('../db');
const { HttpError, BOXES, addCash, boxBalances } = require('../services');
const { emptyToNull, num } = require('./catalog');
const { dateFilters } = require('./operations');

const router = express.Router();

/** Saldos de ambas cajas + movimientos filtrados. */
router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.box) {
    where.push('box = ?');
    params.push(req.query.box);
  }
  dateFilters(req, 'date', where, params);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const movements = db
    .prepare(`SELECT * FROM cash_movements ${w} ORDER BY date DESC, id DESC LIMIT ?`)
    .all(...params, Math.min(num(req.query.limit, 500), 5000));
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END),0) ingresos,
              COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END),0) egresos
       FROM cash_movements ${w}`
    )
    .get(...params);
  res.json({
    balances: boxBalances(),
    period: { ingresos: round2(totals.ingresos), egresos: round2(totals.egresos) },
    movements,
  });
});

/** Ingreso o egreso manual (gastos, retiros, aportes, etc.). */
router.post('/movements', (req, res) => {
  const box = req.body.box;
  if (!BOXES.includes(box)) throw new HttpError(400, 'Elegí la caja');
  const amount = round2(num(req.body.amount));
  if (amount <= 0) throw new HttpError(400, 'El importe debe ser mayor a cero');
  const concept = emptyToNull(req.body.concept);
  if (!concept) throw new HttpError(400, 'Indicá un concepto');
  const sign = req.body.type === 'egreso' ? -1 : 1;
  addCash(box, sign * amount, concept, 'manual');
  res.status(201).json({ ok: true, balances: boxBalances() });
});

/** Pasar dinero de una caja a otra (ej: depositar efectivo en el banco). */
router.post('/transfer', (req, res) => {
  const { from, to } = req.body;
  if (!BOXES.includes(from) || !BOXES.includes(to) || from === to) throw new HttpError(400, 'Cajas inválidas');
  const amount = round2(num(req.body.amount));
  if (amount <= 0) throw new HttpError(400, 'El importe debe ser mayor a cero');
  const concept = emptyToNull(req.body.concept) || `Traspaso ${from} → ${to}`;
  db.transaction(() => {
    addCash(from, -amount, concept, 'traspaso');
    addCash(to, amount, concept, 'traspaso');
  })();
  res.status(201).json({ ok: true, balances: boxBalances() });
});

router.delete('/movements/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM cash_movements WHERE id = ?').get(req.params.id);
  if (!m) throw new HttpError(404, 'Movimiento no encontrado');
  if (m.ref_type !== 'manual')
    throw new HttpError(400, 'Solo se pueden borrar movimientos manuales. Para el resto, anulá la venta/compra.');
  db.prepare('DELETE FROM cash_movements WHERE id = ?').run(m.id);
  res.json({ ok: true });
});

module.exports = router;
