/**
 * Mensajes para WhatsApp: plantillas por anuncio (productos + listas de precios) que generan
 * el texto con precios, disponibilidad y mínimos actualizados al momento de usarlas.
 * Las mismas plantillas sirven después para el bot automático.
 */
const express = require('express');
const { db } = require('../db');
const { HttpError, getSetting, priceFor, reservedMap, defaultPriceListId } = require('../services');
const { emptyToNull } = require('./catalog');

const router = express.Router();

const money = (n) => {
  const v = Math.round(Number(n || 0) * 100) / 100;
  return '$ ' + v.toLocaleString('es-AR', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
};
const slug = (v) =>
  String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
const parseIds = (v) => {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(a) ? a.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 30) : [];
  } catch {
    return [];
  }
};

/** Arma el texto del mensaje con los datos actuales del sistema */
function renderMessage(t, baseUrl) {
  const business = getSetting('business_name') || '';
  const lists = parseIds(t.list_ids)
    .map((id) => db.prepare('SELECT * FROM price_lists WHERE id = ?').get(id))
    .filter(Boolean);
  if (!lists.length) lists.push(db.prepare('SELECT * FROM price_lists WHERE id = ?').get(defaultPriceListId()));
  const reserved = reservedMap();
  const products = parseIds(t.product_ids)
    .map((id) => db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(id))
    .filter(Boolean);
  const many = lists.length > 1;
  const lines = [];
  lines.push(getSetting('wa_greeting') || `¡Hola! 👋 Gracias por escribir a *${business}*.`);
  if (t.intro) lines.push(t.intro);
  for (const p of products) {
    lines.push('');
    lines.push(`🍾 *${p.name}*${p.presentation ? ` (${p.presentation})` : ''}`);
    for (const l of lists) {
      const price = priceFor(p, l).price;
      const pack = p.units_per_pack > 1 ? ` · Bulto x${p.units_per_pack}: ${money(price * p.units_per_pack)}` : '';
      lines.push(`• ${many ? `${l.name}: ` : 'Precio: '}${money(price)} c/u${pack}`);
    }
    if (t.show_stock) {
      const free = p.stock - (reserved.get(p.id) || 0);
      lines.push(free <= 0 ? '❌ Sin stock por el momento' : p.min_stock > 0 && free <= p.min_stock ? '⚠️ Últimas unidades' : '✅ Disponible');
    }
  }
  // Mínimos de compra de las listas elegidas (o el general de la tienda)
  const general = Number(getSetting('shop_min_order')) || 0;
  const mins = lists.map((l) => ({ name: l.name, min: l.min_order > 0 ? l.min_order : general })).filter((m) => m.min > 0);
  if (mins.length) {
    lines.push('');
    lines.push(
      mins.length === 1 && !many
        ? `🛒 Pedido mínimo: *${money(mins[0].min)}*`
        : `🛒 Pedido mínimo: ${mins.map((m) => `${m.name} *${money(m.min)}*`).join(' · ')}`
    );
  }
  const ship = String(getSetting('shop_shipping') || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (ship) lines.push(`🚚 ${ship}`);
  if (getSetting('shop_enabled') === '1' && baseUrl) {
    lines.push('');
    lines.push(`🛍️ Mirá todos los precios y armá tu pedido acá:\n${baseUrl}/tienda?origen=${slug(t.origin) || 'whatsapp'}`);
  }
  const channel = getSetting('wa_channel_url');
  if (channel) {
    lines.push('');
    lines.push(`📢 Sumate a nuestro canal de WhatsApp para enterarte de ofertas y novedades:\n${channel}`);
  }
  if (t.outro) {
    lines.push('');
    lines.push(t.outro);
  }
  return lines.join('\n');
}

const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM wa_templates ORDER BY name').all();
  res.json(rows.map((t) => ({ ...t, product_ids: parseIds(t.product_ids), list_ids: parseIds(t.list_ids), text: renderMessage(t, baseUrl(req)) })));
});

function fields(body) {
  const name = emptyToNull(body.name);
  if (!name) throw new HttpError(400, 'Poné un nombre (ej: "Anuncio Fernet")');
  return {
    name: name.slice(0, 80),
    product_ids: JSON.stringify(parseIds(body.product_ids)),
    list_ids: JSON.stringify(parseIds(body.list_ids)),
    intro: emptyToNull(body.intro),
    outro: emptyToNull(body.outro),
    origin: slug(body.origin) || slug(name),
    show_stock: body.show_stock === false || body.show_stock === '0' ? 0 : 1,
  };
}

router.post('/', (req, res) => {
  const f = fields(req.body);
  const r = db
    .prepare('INSERT INTO wa_templates (name, product_ids, list_ids, intro, outro, origin, show_stock) VALUES (@name,@product_ids,@list_ids,@intro,@outro,@origin,@show_stock)')
    .run(f);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const f = fields(req.body);
  const r = db
    .prepare('UPDATE wa_templates SET name=@name, product_ids=@product_ids, list_ids=@list_ids, intro=@intro, outro=@outro, origin=@origin, show_stock=@show_stock WHERE id=@id')
    .run({ ...f, id: req.params.id });
  if (!r.changes) throw new HttpError(404, 'Mensaje no encontrado');
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM wa_templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/** Vista previa sin guardar */
router.post('/preview', (req, res) => {
  const f = fields({ ...req.body, name: req.body.name || 'vista previa' });
  res.json({ text: renderMessage(f, baseUrl(req)) });
});

module.exports = router;
module.exports.renderMessage = renderMessage;
