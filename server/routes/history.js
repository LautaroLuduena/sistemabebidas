const express = require('express');
const ExcelJS = require('exceljs');
const { db, round2 } = require('../db');
const { HttpError } = require('../services');

const router = express.Router();
const money = (n) => '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Todas las operaciones del sistema en una sola lista, con columnas uniformes.
 * kind: venta | compra | cobro | pago | gasto | ingreso | traspaso | presupuesto | remito | ajuste_stock | ajuste_cc
 */
const OPERATIONS_SQL = `
  SELECT 'venta' kind, s.id, s.date, 'Venta #' || s.id label, COALESCE(c.name, 'Consumidor final') party,
         s.total amount, s.status, NULL box,
         'Efectivo ' || s.paid_cash || ' · Transf. ' || s.paid_transfer || ' · CC ' || s.on_account detail,
         s.customer_id customer_id, NULL supplier_id
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
  UNION ALL
  SELECT 'compra', p.id, p.date, 'Compra #' || p.id || COALESCE(' · Fact. ' || p.invoice_number, ''), COALESCE(sp.name, '—'),
         p.total, p.status, NULL,
         'Efectivo ' || p.paid_cash || ' · Transf. ' || p.paid_transfer || ' · CC ' || p.on_account,
         NULL, p.supplier_id
    FROM purchases p LEFT JOIN suppliers sp ON sp.id = p.supplier_id
  UNION ALL
  SELECT 'cobro', m.id, m.date, m.concept, COALESCE(c.name, ''), m.amount, 'ok', m.box, NULL, m.ref_id, NULL
    FROM cash_movements m LEFT JOIN customers c ON c.id = m.ref_id WHERE m.ref_type = 'cobro'
  UNION ALL
  SELECT 'pago', m.id, m.date, m.concept, COALESCE(sp.name, ''), -m.amount, 'ok', m.box, NULL, NULL, m.ref_id
    FROM cash_movements m LEFT JOIN suppliers sp ON sp.id = m.ref_id WHERE m.ref_type = 'pago'
  UNION ALL
  SELECT CASE WHEN m.amount < 0 THEN 'gasto' ELSE 'ingreso' END, m.id, m.date, m.concept, '', ABS(m.amount), 'ok', m.box, NULL, NULL, NULL
    FROM cash_movements m WHERE m.ref_type = 'manual'
  UNION ALL
  SELECT 'traspaso', m.id, m.date, m.concept, '', -m.amount, 'ok', m.box || ' → ' || CASE m.box WHEN 'efectivo' THEN 'transferencia' ELSE 'efectivo' END, NULL, NULL, NULL
    FROM cash_movements m WHERE m.ref_type = 'traspaso' AND m.amount < 0
  UNION ALL
  SELECT 'presupuesto', q.id, q.date, 'Presupuesto #' || q.id, COALESCE(c.name, q.customer_name, 'Consumidor final'),
         q.total, q.status, NULL, NULL, q.customer_id, NULL
    FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id
  UNION ALL
  SELECT 'remito', r.id, r.date, 'Remito ' || printf('%04d-%08d', r.pv, r.number) || ' (venta #' || r.sale_id || ')',
         COALESCE(c.name, 'Consumidor final'), s.total, r.status, NULL, r.delivery_address, s.customer_id, NULL
    FROM remitos r JOIN sales s ON s.id = r.sale_id LEFT JOIN customers c ON c.id = s.customer_id
  UNION ALL
  SELECT 'ajuste_stock', sm.id, sm.date, 'Ajuste de stock: ' || p.name, '', sm.quantity, 'ok', NULL, sm.notes, NULL, NULL
    FROM stock_movements sm JOIN products p ON p.id = sm.product_id WHERE sm.type = 'ajuste'
  UNION ALL
  SELECT 'ajuste_cc', a.id, a.date, a.concept, COALESCE(c.name, sp.name, ''), a.amount, 'ok', NULL,
         CASE a.party_type WHEN 'cliente' THEN 'Cliente' ELSE 'Proveedor' END,
         CASE a.party_type WHEN 'cliente' THEN a.party_id END, CASE a.party_type WHEN 'proveedor' THEN a.party_id END
    FROM account_movements a
    LEFT JOIN customers c ON a.party_type = 'cliente' AND c.id = a.party_id
    LEFT JOIN suppliers sp ON a.party_type = 'proveedor' AND sp.id = a.party_id
    WHERE a.ref_type IN ('ajuste', 'inicial')
`;

const KINDS = ['venta', 'compra', 'cobro', 'pago', 'gasto', 'ingreso', 'traspaso', 'presupuesto', 'remito', 'ajuste_stock', 'ajuste_cc'];

function historyRows(q) {
  const where = [];
  const params = [];
  if (q.from) {
    where.push('date(date) >= date(?)');
    params.push(q.from);
  }
  if (q.to) {
    where.push('date(date) <= date(?)');
    params.push(q.to);
  }
  const kinds = String(q.kind || '')
    .split(',')
    .filter((k) => KINDS.includes(k));
  if (kinds.length) where.push(`kind IN (${kinds.map(() => '?').join(',')})`), params.push(...kinds);
  if (q.customer_id) where.push('customer_id = ?'), params.push(q.customer_id);
  if (q.supplier_id) where.push('supplier_id = ?'), params.push(q.supplier_id);
  if (q.status === 'activas') where.push("status NOT IN ('anulada', 'anulado')");
  if (q.status === 'anuladas') where.push("status IN ('anulada', 'anulado')");
  if (q.q) {
    where.push('(label LIKE ? OR party LIKE ? OR detail LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  const limit = Math.min(Number(q.limit) || 1000, 10000);
  const rows = db
    .prepare(`SELECT * FROM (${OPERATIONS_SQL}) ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, id DESC LIMIT ?`)
    .all(...params, limit);
  // Detalle de pago legible en ventas y compras: "Efectivo $ 1.000,00 · CC $ 500,00"
  for (const r of rows) {
    if ((r.kind === 'venta' || r.kind === 'compra') && r.detail) {
      r.detail = r.detail
        .split(' · ')
        .map((part) => {
          const i = part.lastIndexOf(' ');
          const n = Number(part.slice(i + 1));
          return n ? `${part.slice(0, i).replace('CC', 'Cta. cte.')} ${money(n)}` : null;
        })
        .filter(Boolean)
        .join(' · ');
    }
  }
  return rows;
}

function summarize(rows) {
  const by = {};
  for (const r of rows) {
    if (r.status === 'anulada' || r.status === 'anulado') continue;
    if (r.kind === 'ajuste_stock') continue; // son unidades, no pesos
    by[r.kind] = by[r.kind] || { count: 0, total: 0 };
    by[r.kind].count++;
    by[r.kind].total = round2(by[r.kind].total + r.amount);
  }
  return by;
}

router.get('/history', (req, res) => {
  const rows = historyRows(req.query);
  res.json({ rows, summary: summarize(rows), truncated: rows.length >= Math.min(Number(req.query.limit) || 1000, 10000) });
});

// ---------------- Resumen mensual ----------------
const ym = (d) => d.toISOString().slice(0, 7);

function monthRange(fromYm, toYm) {
  const out = [];
  let [y, m] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) (m = 1), y++;
    if (out.length > 120) break;
  }
  return out;
}

function monthly(fromYm, toYm) {
  if (!/^\d{4}-\d{2}$/.test(fromYm) || !/^\d{4}-\d{2}$/.test(toYm)) throw new HttpError(400, 'Período inválido');
  const months = monthRange(fromYm, toYm);
  const from = `${fromYm}-01`;
  const to = `${toYm}-31`;
  const map = (rows) => Object.fromEntries(rows.map((r) => [r.month, r]));
  const sales = map(
    db
      .prepare(
        `SELECT strftime('%Y-%m', s.date) month, COUNT(*) n, SUM(s.total) total, SUM(s.discount) discount,
                SUM((SELECT COALESCE(SUM(i.quantity * i.unit_cost), 0) FROM sale_items i WHERE i.sale_id = s.id)) cost,
                SUM((SELECT COALESCE(SUM(i.quantity), 0) FROM sale_items i WHERE i.sale_id = s.id)) units,
                SUM(s.paid_cash) cash, SUM(s.paid_transfer) transfer, SUM(s.on_account) on_account
         FROM sales s WHERE s.status = 'ok' AND date(s.date) BETWEEN date(?) AND date(?) GROUP BY month`
      )
      .all(from, to)
  );
  const purchases = map(
    db
      .prepare(
        `SELECT strftime('%Y-%m', date) month, COUNT(*) n, SUM(total) total FROM purchases
         WHERE status = 'ok' AND date(date) BETWEEN date(?) AND date(?) GROUP BY month`
      )
      .all(from, to)
  );
  const cash = map(
    db
      .prepare(
        `SELECT strftime('%Y-%m', date) month,
                SUM(CASE WHEN ref_type = 'manual' AND amount < 0 THEN -amount ELSE 0 END) gastos,
                SUM(CASE WHEN ref_type = 'manual' AND amount > 0 THEN amount ELSE 0 END) otros_ingresos,
                SUM(CASE WHEN ref_type = 'cobro' THEN amount ELSE 0 END) cobros,
                SUM(CASE WHEN ref_type = 'pago' THEN -amount ELSE 0 END) pagos
         FROM cash_movements WHERE date(date) BETWEEN date(?) AND date(?) GROUP BY month`
      )
      .all(from, to)
  );
  return months.map((month) => {
    const s = sales[month] || {};
    const p = purchases[month] || {};
    const c = cash[month] || {};
    const ventas = round2(s.total || 0);
    const costo = round2(s.cost || 0);
    const bruta = round2(ventas - costo);
    const gastos = round2(c.gastos || 0);
    return {
      month,
      ventas,
      ventas_count: s.n || 0,
      unidades: s.units || 0,
      ticket_promedio: s.n ? round2(ventas / s.n) : 0,
      descuentos: round2(s.discount || 0),
      costo,
      ganancia_bruta: bruta,
      margen: ventas ? round2((bruta / ventas) * 100) : 0,
      gastos,
      ganancia_neta: round2(bruta - gastos),
      compras: round2(p.total || 0),
      compras_count: p.n || 0,
      cobrado_efectivo: round2(s.cash || 0),
      cobrado_transferencia: round2(s.transfer || 0),
      vendido_a_cuenta: round2(s.on_account || 0),
      cobros_cc: round2(c.cobros || 0),
      pagos_proveedores: round2(c.pagos || 0),
      otros_ingresos: round2(c.otros_ingresos || 0),
    };
  });
}

function defaultMonths(q) {
  const now = new Date();
  const to = q.to_month || ym(now);
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const from = q.from_month || ym(new Date(start.getTime() - start.getTimezoneOffset() * 6e4));
  return [from, to];
}

router.get('/reports/monthly', (req, res) => {
  const [from, to] = defaultMonths(req.query);
  res.json({ from, to, months: monthly(from, to) });
});

// ---------------- Detalle de un período ----------------
function periodDetail(from, to) {
  if (!from || !to) throw new HttpError(400, 'Indicá desde y hasta');
  const args = [from, to];
  const SALE_OK = `s.status = 'ok' AND date(s.date) BETWEEN date(?) AND date(?)`;
  return {
    products: db
      .prepare(
        `SELECT COALESCE(p.name, i.description) name, c.name category, SUM(i.quantity) qty, SUM(i.subtotal) total,
                SUM(i.quantity * i.unit_cost) cost, SUM(i.subtotal - i.quantity * i.unit_cost) profit
         FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN products p ON p.id = i.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE ${SALE_OK} GROUP BY COALESCE(i.product_id, i.description) ORDER BY total DESC LIMIT 100`
      )
      .all(...args),
    categories: db
      .prepare(
        `SELECT COALESCE(c.name, 'Sin categoría') name, SUM(i.quantity) qty, SUM(i.subtotal) total,
                SUM(i.subtotal - i.quantity * i.unit_cost) profit
         FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN products p ON p.id = i.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE ${SALE_OK} GROUP BY c.id ORDER BY total DESC`
      )
      .all(...args),
    customers: db
      .prepare(
        `SELECT COALESCE(c.name, 'Consumidor final') name, COUNT(*) n, SUM(s.total) total,
                SUM(s.total - (SELECT COALESCE(SUM(i.quantity * i.unit_cost), 0) FROM sale_items i WHERE i.sale_id = s.id)) profit
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
         WHERE ${SALE_OK} GROUP BY s.customer_id ORDER BY total DESC LIMIT 50`
      )
      .all(...args),
    suppliers: db
      .prepare(
        `SELECT COALESCE(sp.name, 'Sin proveedor') name, COUNT(*) n, SUM(p.total) total
         FROM purchases p LEFT JOIN suppliers sp ON sp.id = p.supplier_id
         WHERE p.status = 'ok' AND date(p.date) BETWEEN date(?) AND date(?) GROUP BY p.supplier_id ORDER BY total DESC`
      )
      .all(...args),
    purchased: db
      .prepare(
        `SELECT COALESCE(pr.name, i.description) name, SUM(i.quantity) qty, SUM(i.subtotal) total,
                ROUND(SUM(i.subtotal) / SUM(i.quantity), 2) avg_cost
         FROM purchase_items i JOIN purchases p ON p.id = i.purchase_id LEFT JOIN products pr ON pr.id = i.product_id
         WHERE p.status = 'ok' AND date(p.date) BETWEEN date(?) AND date(?)
         GROUP BY COALESCE(i.product_id, i.description) ORDER BY total DESC LIMIT 100`
      )
      .all(...args),
    // Tienda online: visitas y pedidos por canal de origen y por localidad
    web_origins: (() => {
      const visits = new Map(
        db
          .prepare(`SELECT origin, COUNT(*) n FROM shop_visits WHERE date(date) BETWEEN date(?) AND date(?) GROUP BY origin`)
          .all(...args)
          .map((r) => [r.origin, r.n])
      );
      const orders = db
        .prepare(
          `SELECT COALESCE(origin, 'directo') name, COUNT(*) orders, SUM(total) ordered,
                  SUM(CASE WHEN status = 'vendido' THEN 1 ELSE 0 END) sold,
                  SUM(CASE WHEN status = 'vendido' THEN total ELSE 0 END) sold_total,
                  SUM(CASE WHEN status = 'anulado' THEN 1 ELSE 0 END) cancelled
           FROM quotes WHERE source = 'web' AND date(date) BETWEEN date(?) AND date(?) GROUP BY COALESCE(origin, 'directo')`
        )
        .all(...args);
      const names = new Set([...visits.keys(), ...orders.map((o) => o.name)]);
      return [...names]
        .map((name) => {
          const o = orders.find((x) => x.name === name) || { orders: 0, ordered: 0, sold: 0, sold_total: 0, cancelled: 0 };
          const v = visits.get(name) || 0;
          return { ...o, name, visits: v, conversion: v ? Math.round((o.orders / v) * 1000) / 10 : null };
        })
        .sort((a, b) => b.sold_total - a.sold_total || b.orders - a.orders || b.visits - a.visits);
    })(),
    web_cities: db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(q.contact_city), ''), NULLIF(TRIM(c.city), ''), 'Sin dato') name, COUNT(*) orders, SUM(q.total) ordered,
                SUM(CASE WHEN q.status = 'vendido' THEN 1 ELSE 0 END) sold,
                SUM(CASE WHEN q.status = 'vendido' THEN q.total ELSE 0 END) sold_total
         FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id
         WHERE q.source = 'web' AND date(q.date) BETWEEN date(?) AND date(?)
         GROUP BY LOWER(COALESCE(NULLIF(TRIM(q.contact_city), ''), NULLIF(TRIM(c.city), ''), 'Sin dato'))
         ORDER BY orders DESC, sold_total DESC`
      )
      .all(...args),
    expenses: db
      .prepare(
        `SELECT concept name, COUNT(*) n, SUM(-amount) total FROM cash_movements
         WHERE ref_type = 'manual' AND amount < 0 AND date(date) BETWEEN date(?) AND date(?)
         GROUP BY concept ORDER BY total DESC`
      )
      .all(...args),
  };
}

router.get('/reports/period', (req, res) => res.json(periodDetail(req.query.from, req.query.to)));

// ---------------- Exportación a Excel ----------------
const KIND_LABEL = {
  venta: 'Venta',
  compra: 'Compra',
  cobro: 'Cobro a cliente',
  pago: 'Pago a proveedor',
  gasto: 'Gasto / egreso',
  ingreso: 'Ingreso manual',
  traspaso: 'Traspaso entre cajas',
  presupuesto: 'Presupuesto',
  remito: 'Remito',
  ajuste_stock: 'Ajuste de stock',
  ajuste_cc: 'Ajuste cuenta corriente',
};

function styleHeader(ws) {
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

async function send(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

router.get('/history.xlsx', async (req, res) => {
  const rows = historyRows({ ...req.query, limit: 10000 });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Historial');
  ws.columns = [
    { header: 'Fecha', key: 'date', width: 18 },
    { header: 'Tipo', key: 'kind', width: 22 },
    { header: 'Operación', key: 'label', width: 40 },
    { header: 'Cliente / Proveedor', key: 'party', width: 28 },
    { header: 'Importe', key: 'amount', width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Caja', key: 'box', width: 16 },
    { header: 'Estado', key: 'status', width: 12 },
    { header: 'Detalle', key: 'detail', width: 40 },
  ];
  styleHeader(ws);
  for (const r of rows) ws.addRow({ ...r, kind: KIND_LABEL[r.kind] || r.kind });
  ws.getColumn('amount').numFmt = '"$"#,##0.00';
  await send(res, wb, `historial_${req.query.from || ''}_${req.query.to || ''}.xlsx`);
});

router.get('/reports/monthly.xlsx', async (req, res) => {
  const [from, to] = defaultMonths(req.query);
  const months = monthly(from, to);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Mes a mes');
  const cols = [
    ['month', 'Mes', 10],
    ['ventas', 'Ventas', 14],
    ['ventas_count', 'Cant. ventas', 12],
    ['ticket_promedio', 'Ticket promedio', 14],
    ['costo', 'Costo de lo vendido', 16],
    ['ganancia_bruta', 'Ganancia bruta', 15],
    ['margen', 'Margen %', 10],
    ['gastos', 'Gastos', 13],
    ['ganancia_neta', 'Ganancia neta', 15],
    ['compras', 'Compras', 14],
    ['compras_count', 'Cant. compras', 12],
    ['cobrado_efectivo', 'Cobrado efectivo', 15],
    ['cobrado_transferencia', 'Cobrado transferencia', 17],
    ['vendido_a_cuenta', 'Vendido a cuenta', 15],
    ['cobros_cc', 'Cobros de CC', 14],
    ['pagos_proveedores', 'Pagos a proveedores', 17],
  ];
  ws.columns = cols.map(([key, header, width]) => ({ key, header, width }));
  styleHeader(ws);
  months.forEach((m) => ws.addRow(m));
  cols.forEach(([key]) => {
    if (!['month', 'ventas_count', 'compras_count', 'margen'].includes(key)) ws.getColumn(key).numFmt = '"$"#,##0.00';
  });
  await send(res, wb, `resumen_mensual_${from}_${to}.xlsx`);
});

module.exports = router;
module.exports._test = { monthly, historyRows };
