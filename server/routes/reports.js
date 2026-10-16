const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, round2, UPLOADS_DIR } = require('../db');
const { boxBalances, getSetting, logoFile, HttpError } = require('../services');

const router = express.Router();

router.get('/dashboard', (req, res) => {
  const today = db
    .prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM sales WHERE status = 'ok' AND date(date) = date('now','localtime')`
    )
    .get();
  const month = db
    .prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM sales
       WHERE status = 'ok' AND strftime('%Y-%m', date) = strftime('%Y-%m', 'now','localtime')`
    )
    .get();
  const monthProfit = db
    .prepare(
      `SELECT COALESCE(SUM(s.total - (SELECT COALESCE(SUM(i.quantity * i.unit_cost), 0) FROM sale_items i WHERE i.sale_id = s.id)), 0) g
       FROM sales s WHERE s.status = 'ok' AND strftime('%Y-%m', s.date) = strftime('%Y-%m', 'now','localtime')`
    )
    .get();
  const receivable = db
    .prepare(
      `SELECT COALESCE(SUM(b),0) total, COUNT(*) n FROM (SELECT party_id, SUM(amount) b FROM account_movements
       WHERE party_type = 'cliente' GROUP BY party_id HAVING b > 0.004)`
    )
    .get();
  const payable = db
    .prepare(
      `SELECT COALESCE(SUM(b),0) total, COUNT(*) n FROM (SELECT party_id, SUM(amount) b FROM account_movements
       WHERE party_type = 'proveedor' GROUP BY party_id HAVING b > 0.004)`
    )
    .get();
  const lowStock = db
    .prepare(
      `SELECT id, name, stock, min_stock FROM products WHERE active = 1 AND stock <= min_stock ORDER BY stock - min_stock LIMIT 15`
    )
    .all();
  const stockValue = db.prepare('SELECT COALESCE(SUM(stock * cost),0) v, COUNT(*) n FROM products WHERE active = 1 AND stock > 0').get();
  const topProducts = db
    .prepare(
      `SELECT i.description, SUM(i.quantity) qty, SUM(i.subtotal) total FROM sale_items i JOIN sales s ON s.id = i.sale_id
       WHERE s.status = 'ok' AND date(s.date) >= date('now','localtime','-30 days')
       GROUP BY COALESCE(i.product_id, i.description) ORDER BY total DESC LIMIT 10`
    )
    .all();
  const last7 = db
    .prepare(
      `SELECT date(date) day, SUM(total) total FROM sales WHERE status = 'ok' AND date(date) >= date('now','localtime','-6 days')
       GROUP BY date(date) ORDER BY day`
    )
    .all();

  res.json({
    boxes: boxBalances(),
    sales_today: { count: today.n, total: round2(today.total) },
    sales_month: { count: month.n, total: round2(month.total), profit: round2(monthProfit.g) },
    receivable: { total: round2(receivable.total), count: receivable.n },
    payable: { total: round2(payable.total), count: payable.n },
    stock_value: { total: round2(stockValue.v), count: stockValue.n },
    low_stock: lowStock,
    top_products: topProducts,
    last7,
  });
});

router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

const ALLOWED_SETTINGS = ['business_name', 'business_address', 'business_phone', 'business_tax_id', 'price_list_footer', 'quote_footer', 'quote_valid_days',
  'business_iva', 'business_iibb', 'business_start', 'remito_pv', 'remito_next', 'remito_copies', 'remito_valued', 'remito_footer',
  'shop_enabled', 'shop_whatsapp', 'shop_price_list', 'shop_stock_mode', 'shop_hide_out_of_stock', 'shop_private', 'shop_min_order', 'shop_message'];
router.put('/settings', (req, res) => {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const k of ALLOWED_SETTINGS) if (req.body[k] !== undefined) up.run(k, String(req.body[k]));
  })();
  res.json({ ok: true });
});

// ---------- Logo del negocio ----------
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `logo_${Date.now()}${file.mimetype === 'image/png' ? '.png' : '.jpg'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png)$/.test(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, 'El logo tiene que ser una imagen PNG o JPG'));
  },
});

const setLogo = (filename) => {
  const old = getSetting('logo');
  db.prepare("INSERT INTO settings (key, value) VALUES ('logo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(filename);
  if (old && old !== filename) fs.promises.unlink(path.join(UPLOADS_DIR, path.basename(old))).catch(() => {});
};

router.post('/settings/logo', logoUpload.single('logo'), (req, res) => {
  if (!req.file) throw new HttpError(400, 'Elegí la imagen del logo');
  setLogo(req.file.filename);
  res.json({ ok: true });
});

router.delete('/settings/logo', (req, res) => {
  const old = getSetting('logo');
  db.prepare("DELETE FROM settings WHERE key = 'logo'").run();
  if (old) fs.promises.unlink(path.join(UPLOADS_DIR, path.basename(old))).catch(() => {});
  res.json({ ok: true });
});

// Rutas públicas (sin sesión): nombre y logo para la pantalla de ingreso y los comprobantes
const publicRouter = express.Router();
publicRouter.get('/branding', (req, res) => {
  res.json({ business_name: getSetting('business_name') || '', has_logo: Boolean(logoFile()) });
});
publicRouter.get('/logo', (req, res) => {
  const file = logoFile();
  if (!file) return res.status(404).json({ error: 'Sin logo' });
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(file);
});

module.exports = router;
module.exports.publicRouter = publicRouter;
