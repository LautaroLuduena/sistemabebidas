/**
 * Tienda online (pública, sin usuario): los clientes ven el catálogo y arman un pedido
 * que queda guardado como "Pedido web" y se envía por WhatsApp.
 * Nunca expone costos ni datos internos. Los precios se calculan siempre en el servidor.
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, round2, UPLOADS_DIR } = require('../db');
const { HttpError, getSetting, getPriceList, priceFor, defaultPriceListId, reservedMap, assertAvailable } = require('../services');

const router = express.Router();

const setting = (k, def) => {
  const v = getSetting(k);
  return v === null || v === '' ? def : v;
};

/**
 * Número para wa.me en formato internacional argentino (549 + área + número).
 * Acepta "351 1234567", "0351 15-1234567", "+54 9 351 123-4567", etc.
 */
function waNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (!d.startsWith('54')) {
    d = d.replace(/^0/, '');
    // Saca el "15" de celulares escritos a la manera local (área de 2 a 4 dígitos + 15 + número)
    if (d.length === 12) d = d.replace(/^(\d{2,4})15(\d{6,8})$/, (m, a, n) => (a.length + n.length === 10 ? a + n : m));
    if (d.length === 10) d = '549' + d;
  } else if (!d.startsWith('549') && d.length === 12) d = '549' + d.slice(2);
  return d;
}

function shopConfig() {
  return {
    enabled: setting('shop_enabled', '0') === '1',
    whatsapp: waNumber(setting('shop_whatsapp', getSetting('business_phone') || '')),
    priceListId: setting('shop_price_list', ''), // '' = predeterminada, 'none' = sin precios
    stockMode: setting('shop_stock_mode', 'disponible'), // exacto | disponible
    hideOutOfStock: setting('shop_hide_out_of_stock', '0') === '1',
    privateMode: setting('shop_private', '0') === '1', // solo clientes con link personal
    minOrder: Number(setting('shop_min_order', 0)) || 0,
    message: setting('shop_message', ''),
  };
}

/** Pedido mínimo: el de la lista de precios del cliente; si la lista no tiene, el general de la tienda. */
const minOrderFor = (cfg, list) => (list && list.min_order > 0 ? list.min_order : cfg.minOrder);

/** Resuelve el contexto del visitante: cliente (por link personal) y lista de precios. */
function context(req) {
  const cfg = shopConfig();
  if (!cfg.enabled) throw new HttpError(403, 'El catálogo online no está disponible en este momento');
  const token = String(req.query.c || req.body?.c || '').trim();
  const customer = token ? db.prepare('SELECT * FROM customers WHERE shop_token = ? AND active = 1').get(token) : null;
  if (token && !customer) throw new HttpError(404, 'El link no es válido. Pedile uno nuevo al negocio.');
  if (cfg.privateMode && !customer) throw new HttpError(403, 'El catálogo es solo para clientes. Pedí tu link personal al negocio.');
  let list = null;
  if (customer && customer.price_list_id) list = getPriceList(customer.price_list_id);
  else if (cfg.priceListId !== 'none') list = getPriceList(cfg.priceListId || defaultPriceListId());
  return { cfg, customer, list };
}

/** Disponible = stock − lo reservado por otros pedidos web en curso. max limita lo que se puede pedir. */
function availability(p, cfg, reserved) {
  const free = Math.max(0, Math.floor((p.stock - (reserved.get(p.id) || 0)) * 100) / 100);
  if (free <= 0) return { available: false, label: 'Sin stock', max: 0 };
  if (cfg.stockMode === 'exacto') return { available: true, label: `${free} disponibles`, max: free };
  if (p.min_stock > 0 && free <= p.min_stock) return { available: true, label: 'Últimas unidades', max: free };
  return { available: true, label: 'Disponible', max: free };
}

router.get('/info', (req, res) => {
  const { cfg, customer, list } = context(req);
  const categories = db
    .prepare(
      `SELECT c.id, c.name FROM categories c WHERE EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id AND p.active = 1) ORDER BY c.name`
    )
    .all();
  res.json({
    business_name: getSetting('business_name') || '',
    business_address: getSetting('business_address') || '',
    business_phone: getSetting('business_phone') || '',
    has_whatsapp: Boolean(cfg.whatsapp),
    show_prices: Boolean(list),
    min_order: minOrderFor(cfg, list),
    message: cfg.message,
    // Información del negocio para la cabecera de la tienda (se edita en Configuración → Tienda online)
    tagline: setting('shop_tagline', 'Ventas por mayor y menor'),
    hours: setting('shop_hours', ''),
    maps_url:
      setting('shop_maps_url', '') ||
      (getSetting('business_address') ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(getSetting('business_address'))}` : ''),
    shipping: setting('shop_shipping', ''),
    payments: [
      setting('shop_pay_cash', '1') === '1' && '💵 Efectivo',
      setting('shop_pay_transfer', '1') === '1' && '🏦 Transferencia',
      setting('shop_pay_account', '0') === '1' && '📒 Cuenta corriente',
      ...String(setting('shop_pay_other', ''))
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ].filter(Boolean),
    payments_note: setting('shop_pay_note', ''),
    show_steps: setting('shop_show_steps', '1') === '1',
    whatsapp: cfg.whatsapp,
    categories,
    customer: customer ? { name: customer.name, phone: customer.phone, address: customer.address } : null,
  });
});

router.get('/products', (req, res) => {
  const { cfg, list } = context(req);
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.brand, p.presentation, p.description, p.units_per_pack, p.stock, p.min_stock, p.image, p.cost,
              p.category_id, c.name category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.active = 1
       ORDER BY COALESCE(c.name, 'zzz'), p.name`
    )
    .all();
  const reserved = reservedMap();
  res.json(
    rows
      .map((p) => ({ p, a: availability(p, cfg, reserved) }))
      .filter(({ a }) => !cfg.hideOutOfStock || a.available)
      .map(({ p, a }) => {
      const price = list ? priceFor(p, list).price : null;
      return {
        id: p.id,
        name: p.name,
        brand: p.brand,
        presentation: p.presentation,
        description: p.description,
        category_id: p.category_id,
        category: p.category,
        units_per_pack: p.units_per_pack,
        price,
        pack_price: price !== null && p.units_per_pack > 1 ? round2(price * p.units_per_pack) : null,
        image_url: p.image ? `/api/shop/img/${p.id}` : null,
        ...a,
      };
    })
  );
});

/** Foto de un producto activo (las fotos internas requieren sesión; esta es la vía pública). */
router.get('/img/:id', (req, res) => {
  if (!shopConfig().enabled) return res.status(404).end();
  const p = db.prepare('SELECT image FROM products WHERE id = ? AND active = 1').get(req.params.id);
  if (!p || !p.image) return res.status(404).end();
  const file = path.join(UPLOADS_DIR, path.basename(p.image));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});

// Límite simple de pedidos por IP para evitar abusos
const orderHits = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const hits = (orderHits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (hits.length >= 10) throw new HttpError(429, 'Hiciste muchos pedidos seguidos. Esperá un rato o escribinos por WhatsApp.');
  hits.push(now);
  orderHits.set(ip, hits);
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const money = (n) => '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

router.post('/orders', (req, res) => {
  const { cfg, customer, list } = context(req);
  const body = req.body || {};
  const name = clean(body.name, 80) || (customer && customer.name) || '';
  const phone = clean(body.phone, 40);
  const address = clean(body.address, 160);
  const notes = clean(body.notes, 500);
  if (!name) throw new HttpError(400, 'Escribí tu nombre');
  if (!customer && !phone) throw new HttpError(400, 'Escribí un teléfono de contacto');
  const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
  const merged = new Map();
  for (const it of items) {
    const id = Number(it.product_id);
    const q = Math.round(Number(it.quantity) * 100) / 100;
    if (!Number.isInteger(id) || !(q > 0) || q > 100000) continue;
    merged.set(id, (merged.get(id) || 0) + q);
  }
  if (!merged.size) throw new HttpError(400, 'El pedido está vacío');
  rateLimit(req.ip);

  const lines = [];
  for (const [id, qty] of merged) {
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(id);
    if (!p) continue;
    const unit = list ? priceFor(p, list).price : 0;
    lines.push({ p, product: p, qty, unit, subtotal: round2(qty * unit) });
  }
  if (!lines.length) throw new HttpError(400, 'Los productos del pedido ya no están disponibles');
  const total = round2(lines.reduce((a, l) => a + l.subtotal, 0));
  const minOrder = minOrderFor(cfg, list);
  if (list && minOrder && total < minOrder) throw new HttpError(400, `El pedido mínimo es de ${money(minOrder)}`);

  const id = db.transaction(() => {
    // No se puede pedir más de lo disponible (stock − reservas de otros pedidos). Dentro de la
    // transacción, así dos pedidos simultáneos no reservan la misma mercadería.
    assertAvailable(lines);
    const validDays = Math.max(1, Math.round(Number(getSetting('quote_valid_days')) || 7));
    const qid = db
      .prepare(
        `INSERT INTO quotes (customer_id, customer_name, price_list_id, subtotal, discount, total, valid_until, notes, source, contact_phone, contact_address, status_changed_at)
         VALUES (?,?,?,?,0,?,?,?, 'web', ?, ?, datetime('now','localtime'))`
      )
      .run(
        customer ? customer.id : null,
        customer ? null : name,
        list ? list.id : defaultPriceListId(),
        total,
        total,
        new Date(Date.now() + validDays * 864e5).toLocaleDateString('sv-SE'),
        [notes, customer && name !== customer.name ? `Pedido hecho por: ${name}` : ''].filter(Boolean).join(' · ') || null,
        phone || null,
        address || null
      ).lastInsertRowid;
    const ins = db.prepare('INSERT INTO quote_items (quote_id, product_id, description, quantity, unit_price, subtotal) VALUES (?,?,?,?,?,?)');
    for (const l of lines) ins.run(qid, l.p.id, l.p.name, l.qty, l.unit, l.subtotal);
    return qid;
  })();

  const business = getSetting('business_name') || '';
  const text = [
    `¡Hola ${business}! Quiero hacer este pedido (N° ${id}):`,
    '',
    ...lines.map((l) => `• ${l.qty} x ${l.p.name}${l.p.presentation ? ` (${l.p.presentation})` : ''}${list ? ` — ${money(l.subtotal)}` : ''}`),
    '',
    ...(list ? [`*Total: ${money(total)}*`, ''] : []),
    `Nombre: ${name}`,
    ...(phone ? [`Teléfono: ${phone}`] : []),
    ...(address ? [`Dirección de entrega: ${address}`] : []),
    ...(notes ? [`Notas: ${notes}`] : []),
  ].join('\n');
  const whatsapp_url = cfg.whatsapp ? `https://wa.me/${cfg.whatsapp}?text=${encodeURIComponent(text)}` : null;
  res.status(201).json({ id, total: list ? total : null, whatsapp_url, message: text });
});

// ---------- Administración (requiere sesión): links personales de clientes ----------
const admin = express.Router();

admin.post('/customers/:id/shop-link', (req, res) => {
  const c = db.prepare('SELECT id, shop_token FROM customers WHERE id = ?').get(req.params.id);
  if (!c) throw new HttpError(404, 'Cliente no encontrado');
  let token = c.shop_token;
  if (!token || req.body.regenerate) {
    token = crypto.randomBytes(12).toString('base64url');
    db.prepare('UPDATE customers SET shop_token = ? WHERE id = ?').run(token, c.id);
  }
  res.json({ token });
});

admin.get('/shop/pending', (req, res) => {
  res.json(db.prepare("SELECT COUNT(*) n FROM quotes WHERE source = 'web' AND status = 'pendiente'").get());
});

module.exports = { publicShop: router, shopAdmin: admin, waNumber };
