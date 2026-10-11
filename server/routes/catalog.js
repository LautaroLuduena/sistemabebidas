const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, round2, UPLOADS_DIR } = require('../db');
const { HttpError, getPriceList, priceFor, pricesForProduct, addStock, defaultPriceListId } = require('../services');

const router = express.Router();

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, `prod_${Date.now()}_${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, 'La imagen debe ser JPG, PNG, WEBP o GIF'));
  },
});

const emptyToNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const num = (v, def = 0) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? def : Number(v));

function removeImageFile(filename) {
  if (!filename) return;
  const file = path.join(UPLOADS_DIR, path.basename(filename));
  fs.promises.unlink(file).catch(() => {});
}

// ---------- Categorías ----------
router.get('/categories', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) products
         FROM categories c ORDER BY c.name`
      )
      .all()
  );
});

router.post('/categories', (req, res) => {
  const name = emptyToNull(req.body.name);
  if (!name) throw new HttpError(400, 'El nombre es obligatorio');
  const r = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
  res.status(201).json({ id: r.lastInsertRowid, name });
});

router.put('/categories/:id', (req, res) => {
  const name = emptyToNull(req.body.name);
  if (!name) throw new HttpError(400, 'El nombre es obligatorio');
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json({ ok: true });
});

router.delete('/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Listas de precios ----------
router.get('/price-lists', (req, res) => {
  res.json(db.prepare('SELECT * FROM price_lists ORDER BY id').all());
});

function savePriceList(req, id) {
  const name = emptyToNull(req.body.name);
  if (!name) throw new HttpError(400, 'El nombre es obligatorio');
  const markup = num(req.body.markup);
  const isDefault = req.body.is_default ? 1 : 0;
  return db.transaction(() => {
    if (isDefault) db.prepare('UPDATE price_lists SET is_default = 0').run();
    if (id) {
      db.prepare('UPDATE price_lists SET name=?, description=?, markup=?, is_default=? WHERE id=?').run(
        name,
        emptyToNull(req.body.description),
        markup,
        isDefault,
        id
      );
      return id;
    }
    return db
      .prepare('INSERT INTO price_lists (name, description, markup, is_default) VALUES (?,?,?,?)')
      .run(name, emptyToNull(req.body.description), markup, isDefault).lastInsertRowid;
  })();
}

router.post('/price-lists', (req, res) => {
  res.status(201).json({ id: savePriceList(req) });
});

router.put('/price-lists/:id', (req, res) => {
  getPriceList(req.params.id);
  savePriceList(req, Number(req.params.id));
  res.json({ ok: true });
});

router.delete('/price-lists/:id', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM price_lists').get().n;
  if (n <= 1) throw new HttpError(400, 'Debe existir al menos una lista de precios');
  db.prepare('DELETE FROM price_lists WHERE id = ?').run(req.params.id);
  if (!db.prepare('SELECT 1 FROM price_lists WHERE is_default = 1').get()) {
    db.prepare('UPDATE price_lists SET is_default = 1 WHERE id = (SELECT MIN(id) FROM price_lists)').run();
  }
  res.json({ ok: true });
});

/**
 * Actualización masiva de precios: aplica un % de aumento (o baja) a los precios de una lista.
 * mode = 'precios' -> ajusta precios fijos de la lista (y fija los calculados).
 * mode = 'costos'  -> ajusta el costo de los productos (todas las listas por recargo se actualizan solas).
 */
router.post('/price-lists/:id/adjust', (req, res) => {
  const list = getPriceList(req.params.id);
  const percent = num(req.body.percent, NaN);
  if (isNaN(percent)) throw new HttpError(400, 'Porcentaje inválido');
  const factor = 1 + percent / 100;
  const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
  const products = db
    .prepare(`SELECT * FROM products WHERE active = 1 ${categoryId ? 'AND category_id = ?' : ''}`)
    .all(...(categoryId ? [categoryId] : []));
  const upsert = db.prepare(
    `INSERT INTO product_prices (product_id, price_list_id, price) VALUES (?,?,?)
     ON CONFLICT(product_id, price_list_id) DO UPDATE SET price = excluded.price`
  );
  db.transaction(() => {
    for (const p of products) {
      if (req.body.mode === 'costos') {
        db.prepare('UPDATE products SET cost = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(
          round2(p.cost * factor),
          p.id
        );
      } else {
        upsert.run(p.id, list.id, round2(priceFor(p, list).price * factor));
      }
    }
  })();
  res.json({ ok: true, updated: products.length });
});

// ---------- Productos ----------
const PRODUCT_SELECT = `SELECT p.*, c.name category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

function decorate(product, list) {
  if (!product) return product;
  product.image_url = product.image ? `/uploads/${product.image}` : null;
  if (list) product.price = priceFor(product, list).price;
  return product;
}

router.get('/products', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.include_inactive !== '1') where.push('p.active = 1');
  if (req.query.q) {
    where.push('(p.name LIKE ? OR p.code LIKE ? OR p.barcode LIKE ? OR p.brand LIKE ?)');
    const q = `%${req.query.q}%`;
    params.push(q, q, q, q);
  }
  if (req.query.category_id) {
    where.push('p.category_id = ?');
    params.push(req.query.category_id);
  }
  if (req.query.low_stock === '1') where.push('p.stock <= p.min_stock');
  const sql = `${PRODUCT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name LIMIT ?`;
  params.push(Math.min(num(req.query.limit, 500), 5000));
  const list = getPriceList(req.query.price_list_id || defaultPriceListId());
  const rows = db.prepare(sql).all(...params).map((p) => decorate(p, list));
  res.json(rows);
});

router.get('/products/barcode/:barcode', (req, res) => {
  const p = db.prepare(`${PRODUCT_SELECT} WHERE p.barcode = ? OR p.code = ?`).get(req.params.barcode, req.params.barcode);
  if (!p) throw new HttpError(404, 'No se encontró un producto con ese código');
  const list = getPriceList(req.query.price_list_id || defaultPriceListId());
  res.json(decorate(p, list));
});

router.get('/products/:id', (req, res) => {
  const p = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(req.params.id);
  if (!p) throw new HttpError(404, 'Producto no encontrado');
  decorate(p);
  p.prices = pricesForProduct(p);
  res.json(p);
});

router.get('/products/:id/movements', (req, res) => {
  res.json(
    db.prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id DESC LIMIT 200').all(req.params.id)
  );
});

function productFields(body) {
  const name = emptyToNull(body.name);
  if (!name) throw new HttpError(400, 'El nombre del producto es obligatorio');
  return {
    code: emptyToNull(body.code),
    barcode: emptyToNull(body.barcode),
    name,
    description: emptyToNull(body.description),
    category_id: body.category_id ? Number(body.category_id) : null,
    brand: emptyToNull(body.brand),
    presentation: emptyToNull(body.presentation),
    units_per_pack: Math.max(1, Math.round(num(body.units_per_pack, 1))),
    cost: round2(num(body.cost)),
    min_stock: num(body.min_stock),
    active: body.active === undefined ? 1 : body.active === true || body.active === '1' || body.active === 1 ? 1 : 0,
  };
}

/** prices puede venir como JSON string (multipart) u objeto: { [price_list_id]: precio | '' } */
function saveFixedPrices(productId, prices) {
  if (!prices) return;
  if (typeof prices === 'string') prices = JSON.parse(prices);
  const upsert = db.prepare(
    `INSERT INTO product_prices (product_id, price_list_id, price) VALUES (?,?,?)
     ON CONFLICT(product_id, price_list_id) DO UPDATE SET price = excluded.price`
  );
  const del = db.prepare('DELETE FROM product_prices WHERE product_id = ? AND price_list_id = ?');
  for (const [listId, price] of Object.entries(prices)) {
    if (price === '' || price === null || price === undefined) del.run(productId, listId);
    else upsert.run(productId, listId, round2(price));
  }
}

function uniqueError(e) {
  if (String(e.message).includes('UNIQUE') && String(e.message).includes('barcode'))
    return new HttpError(409, 'Ya existe un producto con ese código de barras');
  if (String(e.message).includes('UNIQUE') && String(e.message).includes('code'))
    return new HttpError(409, 'Ya existe un producto con ese código interno');
  return e;
}

router.post('/products', imageUpload.single('image'), (req, res) => {
  const f = productFields(req.body);
  try {
    const id = db.transaction(() => {
      const r = db
        .prepare(
          `INSERT INTO products (code, barcode, name, description, category_id, brand, presentation, units_per_pack, cost, min_stock, active, image)
           VALUES (@code, @barcode, @name, @description, @category_id, @brand, @presentation, @units_per_pack, @cost, @min_stock, @active, @image)`
        )
        .run({ ...f, image: req.file ? req.file.filename : null });
      const id = r.lastInsertRowid;
      const initial = num(req.body.stock);
      if (initial) addStock(id, initial, 'inicial', null, 'Stock inicial');
      saveFixedPrices(id, req.body.prices);
      return id;
    })();
    res.status(201).json({ id });
  } catch (e) {
    if (req.file) removeImageFile(req.file.filename);
    throw uniqueError(e);
  }
});

router.put('/products/:id', imageUpload.single('image'), (req, res) => {
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!current) throw new HttpError(404, 'Producto no encontrado');
  const f = productFields(req.body);
  let image = current.image;
  if (req.file) image = req.file.filename;
  else if (req.body.remove_image === '1' || req.body.remove_image === true) image = null;
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE products SET code=@code, barcode=@barcode, name=@name, description=@description, category_id=@category_id,
           brand=@brand, presentation=@presentation, units_per_pack=@units_per_pack, cost=@cost, min_stock=@min_stock,
           active=@active, image=@image, updated_at=datetime('now','localtime') WHERE id=@id`
      ).run({ ...f, image, id: current.id });
      saveFixedPrices(current.id, req.body.prices);
    })();
  } catch (e) {
    if (req.file) removeImageFile(req.file.filename);
    throw uniqueError(e);
  }
  if (image !== current.image) removeImageFile(current.image);
  res.json({ ok: true });
});

router.delete('/products/:id', (req, res) => {
  const used =
    db.prepare('SELECT 1 FROM sale_items WHERE product_id = ? LIMIT 1').get(req.params.id) ||
    db.prepare('SELECT 1 FROM purchase_items WHERE product_id = ? LIMIT 1').get(req.params.id);
  if (used) {
    // Tiene historial: se da de baja pero se conserva
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
    return res.json({ ok: true, deactivated: true });
  }
  const p = db.prepare('SELECT image FROM products WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  if (p) removeImageFile(p.image);
  res.json({ ok: true });
});

/** Ajuste de stock manual: quantity puede ser positiva o negativa, o set_to fija el stock exacto. */
router.post('/products/:id/stock', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) throw new HttpError(404, 'Producto no encontrado');
  let qty = num(req.body.quantity);
  if (req.body.set_to !== undefined && req.body.set_to !== '') qty = num(req.body.set_to) - p.stock;
  if (!qty) throw new HttpError(400, 'Indicá una cantidad distinta de cero');
  db.transaction(() => addStock(p.id, qty, 'ajuste', null, emptyToNull(req.body.notes) || 'Ajuste manual'))();
  res.json({ ok: true, stock: p.stock + qty });
});

module.exports = router;
module.exports.emptyToNull = emptyToNull;
module.exports.num = num;
