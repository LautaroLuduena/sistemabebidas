const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { db, round2, UPLOADS_DIR } = require('../db');
const { HttpError, getPriceList, priceFor, getSetting, addStock } = require('../services');
const { getSale, getQuote } = require('./operations');

const router = express.Router();
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------------- utilidades ----------------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) =>
  '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Normaliza encabezados: "Código de Barras" -> "codigo_de_barras" */
const normKey = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** Acepta 1234.56 | 1.234,56 | 1234,56 | $ 1.500 */
function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.result !== undefined) return parseNumber(v.result);
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // 1.500 -> 1500 (separador de miles)
  }
  const n = Number(s);
  return isNaN(n) ? null : n;
}

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

/** Parser CSV simple con soporte de comillas; detecta separador ; o , o tab. */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const counts = { ';': (firstLine.match(/;/g) || []).length, ',': (firstLine.match(/,/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length };
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => String(f).trim() !== ''));
}

async function readSpreadsheet(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    let text = file.buffer.toString('utf8');
    if (text.includes('�')) text = file.buffer.toString('latin1'); // CSV guardado por Excel en ANSI
    return parseCSV(text);
  }
  if (!name.endsWith('.xlsx')) throw new HttpError(400, 'Formato no soportado. Usá un archivo .xlsx o .csv');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new HttpError(400, 'El archivo no tiene hojas');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals = [];
    for (let i = 1; i <= ws.columnCount; i++) vals.push(r.getCell(i).value);
    rows.push(vals);
  });
  return rows;
}

// Alias aceptados para cada columna
const COLUMN_ALIASES = {
  code: ['codigo', 'cod', 'sku', 'codigo_interno', 'id_producto'],
  barcode: ['codigo_barras', 'codigo_de_barras', 'cod_barras', 'barcode', 'ean', 'ean13', 'upc'],
  name: ['nombre', 'producto', 'descripcion_corta', 'articulo', 'name'],
  category: ['categoria', 'rubro', 'familia', 'category'],
  brand: ['marca', 'brand'],
  presentation: ['presentacion', 'envase', 'formato', 'contenido'],
  units_per_pack: ['unidades_bulto', 'unidades_por_bulto', 'unid_bulto', 'pack', 'bulto'],
  cost: ['costo', 'precio_costo', 'cost'],
  stock: ['stock', 'cantidad', 'existencia'],
  min_stock: ['stock_minimo', 'minimo', 'stock_min'],
  description: ['descripcion', 'detalle', 'description'],
  active: ['activo'],
};

function buildHeaderMap(headerRow, lists) {
  const map = {};
  const priceCols = {};
  headerRow.forEach((h, idx) => {
    const k = normKey(cellText(h));
    if (!k) return;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(k) && map[field] === undefined) {
        map[field] = idx;
        return;
      }
    }
    // Columnas de precio: "precio_minorista", "Precio Mayorista", o directamente el nombre de la lista
    for (const l of lists) {
      const ln = normKey(l.name);
      if (k === `precio_${ln}` || k === ln || k === `${ln}_precio`) {
        priceCols[l.id] = idx;
        return;
      }
    }
  });
  return { map, priceCols };
}

// ---------------- Plantilla / exportación de inventario ----------------
async function inventoryWorkbook({ empty }) {
  const lists = db.prepare('SELECT * FROM price_lists ORDER BY id').all();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Productos');
  const columns = [
    { header: 'codigo', key: 'code', width: 12 },
    { header: 'codigo_barras', key: 'barcode', width: 16 },
    { header: 'nombre', key: 'name', width: 36 },
    { header: 'categoria', key: 'category', width: 16 },
    { header: 'marca', key: 'brand', width: 14 },
    { header: 'presentacion', key: 'presentation', width: 14 },
    { header: 'unidades_bulto', key: 'units_per_pack', width: 14 },
    { header: 'costo', key: 'cost', width: 12 },
    { header: 'stock', key: 'stock', width: 10 },
    { header: 'stock_minimo', key: 'min_stock', width: 12 },
    { header: 'descripcion', key: 'description', width: 30 },
    ...lists.map((l) => ({ header: `precio_${normKey(l.name)}`, key: `price_${l.id}`, width: 16 })),
  ];
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  if (empty) {
    ws.addRow({
      code: 'BEB001', barcode: '7790895000997', name: 'Coca-Cola Original 2.25L', category: 'Gaseosas', brand: 'Coca-Cola',
      presentation: 'Botella 2.25L', units_per_pack: 8, cost: 1800, stock: 48, min_stock: 16, description: '',
    });
    const help = wb.addWorksheet('Instrucciones');
    help.getColumn(1).width = 110;
    [
      'IMPORTACIÓN MASIVA DE PRODUCTOS',
      '',
      '• Completá una fila por producto en la hoja "Productos". Solo "nombre" es obligatorio.',
      '• Si el código de barras o el código interno ya existe, el producto se ACTUALIZA; si no, se CREA.',
      '• Las columnas precio_<lista> son opcionales: si las dejás vacías el precio se calcula con el % de recargo de la lista sobre el costo.',
      '• La categoría se crea automáticamente si no existe.',
      '• También podés subir un .csv (separado por ; o ,) con los mismos encabezados.',
      '• Para las fotos usá "Importar imágenes": nombrá cada archivo con el código de barras o el código interno (ej: 7790895000997.jpg).',
    ].forEach((t, i) => {
      help.addRow([t]);
      if (i === 0) help.getRow(1).font = { bold: true, size: 14 };
    });
    return wb;
  }
  const products = db
    .prepare('SELECT p.*, c.name category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.active = 1 ORDER BY p.name')
    .all();
  const fixed = db.prepare('SELECT price FROM product_prices WHERE product_id = ? AND price_list_id = ?');
  for (const p of products) {
    const row = { ...p };
    for (const l of lists) {
      const f = fixed.get(p.id, l.id);
      row[`price_${l.id}`] = f ? f.price : null;
    }
    ws.addRow(row);
  }
  return wb;
}

async function sendWorkbook(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

router.get('/import/template.xlsx', async (req, res) => {
  await sendWorkbook(res, await inventoryWorkbook({ empty: true }), 'plantilla_productos.xlsx');
});

router.get('/products/export.xlsx', async (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  await sendWorkbook(res, await inventoryWorkbook({ empty: false }), `inventario_${date}.xlsx`);
});

// ---------------- Importación masiva ----------------
router.post('/import/products', memUpload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Subí un archivo');
  const stockMode = req.body.stock_mode === 'sumar' ? 'sumar' : 'reemplazar';
  const updateExisting = req.body.update_existing !== '0';
  const rows = await readSpreadsheet(req.file);
  if (rows.length < 2) throw new HttpError(400, 'El archivo no tiene datos (la primera fila debe ser de encabezados)');
  const lists = db.prepare('SELECT * FROM price_lists').all();
  const { map, priceCols } = buildHeaderMap(rows[0], lists);
  if (map.name === undefined) throw new HttpError(400, 'No se encontró la columna "nombre"');

  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  const get = (row, field) => (map[field] === undefined ? undefined : row[map[field]]);
  const catCache = new Map(db.prepare('SELECT id, name FROM categories').all().map((c) => [c.name.toLowerCase(), c.id]));
  const categoryId = (name) => {
    if (!name) return null;
    const key = name.toLowerCase();
    if (!catCache.has(key)) catCache.set(key, db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid);
    return catCache.get(key);
  };
  const upsertPrice = db.prepare(
    `INSERT INTO product_prices (product_id, price_list_id, price) VALUES (?,?,?)
     ON CONFLICT(product_id, price_list_id) DO UPDATE SET price = excluded.price`
  );

  db.transaction(() => {
    rows.slice(1).forEach((row, i) => {
      const rowNum = i + 2;
      try {
        const name = cellText(get(row, 'name'));
        if (!name) {
          result.skipped++;
          return;
        }
        const code = cellText(get(row, 'code')) || null;
        const barcode = cellText(get(row, 'barcode')) || null;
        let existing = null;
        if (barcode) existing = db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);
        if (!existing && code) existing = db.prepare('SELECT * FROM products WHERE code = ?').get(code);
        if (existing && !updateExisting) {
          result.skipped++;
          return;
        }

        // Solo se pisan los campos presentes en el archivo
        const data = { name };
        if (map.code !== undefined) data.code = code;
        if (map.barcode !== undefined) data.barcode = barcode;
        if (map.category !== undefined) data.category_id = categoryId(cellText(get(row, 'category')));
        for (const f of ['brand', 'presentation', 'description']) if (map[f] !== undefined) data[f] = cellText(get(row, f)) || null;
        for (const f of ['cost', 'min_stock']) {
          const n = parseNumber(get(row, f));
          if (map[f] !== undefined && n !== null) data[f] = f === 'cost' ? round2(n) : n;
        }
        const upp = parseNumber(get(row, 'units_per_pack'));
        if (upp) data.units_per_pack = Math.max(1, Math.round(upp));
        if (map.active !== undefined) data.active = /^(0|no|n|false)$/i.test(cellText(get(row, 'active'))) ? 0 : 1;

        let id;
        if (existing) {
          id = existing.id;
          const cols = Object.keys(data);
          db.prepare(`UPDATE products SET ${cols.map((c) => `${c}=@${c}`).join(',')}, updated_at=datetime('now','localtime') WHERE id=@id`).run({
            ...data,
            id,
          });
          result.updated++;
        } else {
          const cols = Object.keys(data);
          id = db.prepare(`INSERT INTO products (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(data).lastInsertRowid;
          result.created++;
        }

        const stock = parseNumber(get(row, 'stock'));
        if (map.stock !== undefined && stock !== null) {
          const current = existing ? db.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock : 0;
          const delta = stockMode === 'sumar' || !existing ? stock : stock - current;
          addStock(id, delta, 'importacion', null, `Importación ${req.file.originalname}`);
        }
        for (const [listId, idx] of Object.entries(priceCols)) {
          const price = parseNumber(row[idx]);
          if (price !== null) upsertPrice.run(id, listId, round2(price));
        }
      } catch (e) {
        let msg = e.message;
        if (msg.includes('UNIQUE')) msg = 'Código o código de barras duplicado con otro producto';
        result.errors.push({ row: rowNum, message: msg });
      }
    });
  })();
  res.json(result);
});

/** Importación masiva de fotos: el nombre del archivo debe ser el código de barras o el código interno. */
const imagesUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) =>
      cb(null, `prod_${Date.now()}_${Math.round(Math.random() * 1e6)}${(path.extname(file.originalname) || '.jpg').toLowerCase()}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 500 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
});

router.post('/import/images', imagesUpload.array('images', 500), (req, res) => {
  const result = { matched: 0, unmatched: [] };
  for (const f of req.files || []) {
    const key = path.basename(Buffer.from(f.originalname, 'latin1').toString('utf8'), path.extname(f.originalname)).trim();
    const p = db.prepare('SELECT id, image FROM products WHERE barcode = ? OR code = ?').get(key, key);
    if (!p) {
      result.unmatched.push(f.originalname);
      fs.promises.unlink(f.path).catch(() => {});
      continue;
    }
    db.prepare("UPDATE products SET image = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(f.filename, p.id);
    if (p.image) fs.promises.unlink(path.join(UPLOADS_DIR, path.basename(p.image))).catch(() => {});
    result.matched++;
  }
  res.json(result);
});

// ---------------- Listas de precios: Excel e impresión ----------------
function priceListRows(list, query) {
  const where = ['p.active = 1'];
  const params = [];
  if (query.category_id) {
    where.push('p.category_id = ?');
    params.push(query.category_id);
  }
  if (query.only_stock === '1') where.push('p.stock > 0');
  return db
    .prepare(
      `SELECT p.*, c.name category FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where.join(' AND ')} ORDER BY COALESCE(c.name, 'zzz'), p.name`
    )
    .all(...params)
    .map((p) => {
      const price = priceFor(p, list).price;
      return { ...p, price, pack_price: p.units_per_pack > 1 ? round2(price * p.units_per_pack) : null };
    });
}

function resolveList(req) {
  if (req.query.customer_id) {
    const c = db.prepare('SELECT price_list_id FROM customers WHERE id = ?').get(req.query.customer_id);
    if (c && c.price_list_id) return getPriceList(c.price_list_id);
  }
  return getPriceList(req.params.id);
}

router.get('/price-lists/:id/export.xlsx', async (req, res) => {
  const list = resolveList(req);
  const rows = priceListRows(list, req.query);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(list.name.slice(0, 30));
  const business = getSetting('business_name') || '';
  ws.addRow([business]).font = { bold: true, size: 14 };
  ws.addRow([`Lista de precios: ${list.name}`, '', '', '', `Fecha: ${new Date().toLocaleDateString('es-AR')}`]);
  ws.addRow([]);
  const header = ws.addRow(['Código', 'Cód. barras', 'Producto', 'Categoría', 'Presentación', 'Precio unitario', 'Unid. x bulto', 'Precio bulto']);
  header.font = { bold: true };
  header.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }));
  for (const r of rows) {
    ws.addRow([r.code, r.barcode, r.name, r.category, r.presentation, r.price, r.units_per_pack, r.pack_price]);
  }
  [10, 16, 40, 16, 16, 15, 12, 15].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getColumn(6).numFmt = '"$"#,##0.00';
  ws.getColumn(8).numFmt = '"$"#,##0.00';
  const footer = getSetting('price_list_footer');
  if (footer) {
    ws.addRow([]);
    ws.addRow([footer]);
  }
  await sendWorkbook(res, wb, `lista_${normKey(list.name)}_${new Date().toISOString().slice(0, 10)}.xlsx`);
});

const PRINT_CSS = `
  *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;font-size:12px}
  h1{font-size:20px;margin:0} .muted{color:#555} .head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px}
  table{width:100%;border-collapse:collapse} th,td{padding:5px 6px;border-bottom:1px solid #ddd;text-align:left;vertical-align:middle}
  th{background:#f1f5f9;font-size:11px;text-transform:uppercase} td.n,th.n{text-align:right;white-space:nowrap}
  tr.cat td{background:#111;color:#fff;font-weight:bold;font-size:13px}
  img.ph{width:48px;height:48px;object-fit:contain} .noprint{margin-bottom:16px}
  .noprint button{padding:8px 16px;font-size:14px;cursor:pointer}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px} .card{border:1px solid #ddd;border-radius:6px;padding:8px;text-align:center;break-inside:avoid}
  .card img{width:100%;height:110px;object-fit:contain} .card .p{font-size:15px;font-weight:bold;margin-top:4px}
  .totals td{border:none} @media print{.noprint{display:none} body{margin:8mm}}
`;

router.get('/price-lists/:id/print', (req, res) => {
  const list = resolveList(req);
  const rows = priceListRows(list, req.query);
  const photos = req.query.photos === '1';
  const layout = req.query.layout === 'catalogo' ? 'catalogo' : 'lista';
  const customer = req.query.customer_id ? db.prepare('SELECT name FROM customers WHERE id = ?').get(req.query.customer_id) : null;
  const business = getSetting('business_name') || '';
  const contact = [getSetting('business_address'), getSetting('business_phone')].filter(Boolean).join(' · ');
  let body = '';
  if (layout === 'catalogo') {
    let cat = null;
    for (const r of rows) {
      if (r.category !== cat) {
        if (cat !== null) body += '</div>';
        cat = r.category;
        body += `<h2>${esc(cat || 'Sin categoría')}</h2><div class="grid">`;
      }
      body += `<div class="card">${r.image ? `<img src="/uploads/${esc(r.image)}">` : '<div style="height:110px"></div>'}
        <div>${esc(r.name)}</div><div class="muted">${esc(r.presentation || '')}</div><div class="p">${money(r.price)}</div>
        ${r.pack_price ? `<div class="muted">Bulto x${r.units_per_pack}: ${money(r.pack_price)}</div>` : ''}</div>`;
    }
    if (cat !== null) body += '</div>';
  } else {
    body = `<table><thead><tr>${photos ? '<th></th>' : ''}<th>Código</th><th>Producto</th><th>Presentación</th>
      <th class="n">Precio unit.</th><th class="n">Bulto</th><th class="n">Precio bulto</th></tr></thead><tbody>`;
    let cat;
    const span = photos ? 7 : 6;
    for (const r of rows) {
      if (r.category !== cat) {
        cat = r.category;
        body += `<tr class="cat"><td colspan="${span}">${esc(cat || 'Sin categoría')}</td></tr>`;
      }
      body += `<tr>${photos ? `<td>${r.image ? `<img class="ph" src="/uploads/${esc(r.image)}">` : ''}</td>` : ''}
        <td>${esc(r.code || r.barcode || '')}</td><td>${esc(r.name)}</td><td>${esc(r.presentation || '')}</td>
        <td class="n">${money(r.price)}</td><td class="n">${r.units_per_pack > 1 ? 'x' + r.units_per_pack : ''}</td>
        <td class="n">${r.pack_price ? money(r.pack_price) : ''}</td></tr>`;
    }
    body += '</tbody></table>';
  }
  const footer = getSetting('price_list_footer');
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Lista ${esc(list.name)}</title><style>${PRINT_CSS}</style></head><body>
    <div class="noprint"><button onclick="print()">🖨️ Imprimir / Guardar como PDF</button></div>
    <div class="head"><div><h1>${esc(business)}</h1><div class="muted">${esc(contact)}</div></div>
      <div style="text-align:right"><b>Lista de precios: ${esc(list.name)}</b>${customer ? `<div>Cliente: ${esc(customer.name)}</div>` : ''}
      <div class="muted">${new Date().toLocaleDateString('es-AR')} · ${rows.length} productos</div></div></div>
    ${body}
    ${footer ? `<p class="muted" style="margin-top:16px">${esc(footer)}</p>` : ''}
    </body></html>`);
});

// ---------------- Comprobante de venta ----------------
router.get('/sales/:id/ticket', (req, res) => {
  const s = getSale(req.params.id);
  const business = getSetting('business_name') || '';
  const contact = [getSetting('business_address'), getSetting('business_phone'), getSetting('business_tax_id')].filter(Boolean).join(' · ');
  const items = s.items
    .map(
      (i) => `<tr><td>${esc(i.description)}</td><td class="n">${i.quantity}</td><td class="n">${money(i.unit_price)}</td><td class="n">${money(i.subtotal)}</td></tr>`
    )
    .join('');
  const pay = [
    s.paid_cash ? `<tr><td>Efectivo</td><td class="n">${money(s.paid_cash)}</td></tr>` : '',
    s.paid_transfer ? `<tr><td>Transferencia</td><td class="n">${money(s.paid_transfer)}</td></tr>` : '',
    s.on_account ? `<tr><td>Cuenta corriente</td><td class="n">${money(s.on_account)}</td></tr>` : '',
  ].join('');
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Venta #${s.id}</title><style>${PRINT_CSS} body{max-width:720px}</style></head><body>
    <div class="noprint"><button onclick="print()">🖨️ Imprimir</button></div>
    <div class="head"><div><h1>${esc(business)}</h1><div class="muted">${esc(contact)}</div></div>
      <div style="text-align:right"><b>Comprobante de venta #${s.id}</b><div class="muted">${esc(s.date)}</div>
      ${s.status === 'anulada' ? '<div style="color:#b91c1c;font-weight:bold">ANULADA</div>' : ''}</div></div>
    <p><b>Cliente:</b> ${esc(s.customer_name || 'Consumidor final')} ${s.customer_tax_id ? '· ' + esc(s.customer_tax_id) : ''}
      ${s.customer_address ? '<br><b>Dirección:</b> ' + esc(s.customer_address) : ''}<br><b>Lista:</b> ${esc(s.price_list_name || '')}</p>
    <table><thead><tr><th>Producto</th><th class="n">Cant.</th><th class="n">P. unit.</th><th class="n">Subtotal</th></tr></thead><tbody>${items}</tbody></table>
    <table class="totals" style="width:300px;margin-left:auto;margin-top:12px">
      <tr><td>Subtotal</td><td class="n">${money(s.subtotal)}</td></tr>
      ${s.discount ? `<tr><td>Descuento</td><td class="n">-${money(s.discount)}</td></tr>` : ''}
      <tr><td><b>TOTAL</b></td><td class="n"><b>${money(s.total)}</b></td></tr>${pay}</table>
    ${s.notes ? `<p><b>Notas:</b> ${esc(s.notes)}</p>` : ''}
    <p class="muted" style="margin-top:24px">Documento no válido como factura.</p>
    </body></html>`);
});

// ---------------- Presupuesto ----------------
const fmtDate = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');

router.get('/quotes/:id/print', (req, res) => {
  const q = getQuote(req.params.id);
  const photos = req.query.photos === '1';
  const business = getSetting('business_name') || '';
  const contact = [getSetting('business_address'), getSetting('business_phone'), getSetting('business_tax_id')].filter(Boolean).join(' · ');
  const conditions = getSetting('quote_footer');
  const items = q.items
    .map(
      (i) => `<tr>${photos ? `<td>${i.image ? `<img class="ph" src="/uploads/${esc(i.image)}">` : ''}</td>` : ''}
        <td>${esc(i.description)}</td><td class="n">${i.quantity}</td><td class="n">${money(i.unit_price)}</td><td class="n">${money(i.subtotal)}</td></tr>`
    )
    .join('');
  const status =
    q.status === 'anulado'
      ? '<div style="color:#b91c1c;font-weight:bold">ANULADO</div>'
      : q.status === 'vendido'
        ? `<div style="color:#15803d;font-weight:bold">CONVERTIDO EN VENTA #${q.sale_id}</div>`
        : '';
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Presupuesto #${q.id}</title><style>${PRINT_CSS} body{max-width:760px}</style></head><body>
    <div class="noprint"><button onclick="print()">🖨️ Imprimir / Guardar como PDF</button>
      <a href="?${photos ? '' : 'photos=1'}" style="margin-left:12px">${photos ? 'Ocultar fotos' : 'Mostrar fotos'}</a></div>
    <div class="head"><div><h1>${esc(business)}</h1><div class="muted">${esc(contact)}</div></div>
      <div style="text-align:right"><b style="font-size:16px">PRESUPUESTO N° ${String(q.id).padStart(6, '0')}</b>
      <div class="muted">Fecha: ${fmtDate(q.date)}</div>
      ${q.valid_until ? `<div class="muted">Válido hasta: <b>${fmtDate(q.valid_until)}</b></div>` : ''}${status}</div></div>
    <p><b>Cliente:</b> ${esc(q.customer_name || 'Consumidor final')} ${q.customer_tax_id ? '· ' + esc(q.customer_tax_id) : ''}
      ${q.customer_address ? '<br><b>Dirección:</b> ' + esc(q.customer_address) : ''}
      ${q.customer_phone ? '<br><b>Teléfono:</b> ' + esc(q.customer_phone) : ''}</p>
    <table><thead><tr>${photos ? '<th></th>' : ''}<th>Producto</th><th class="n">Cant.</th><th class="n">P. unit.</th><th class="n">Subtotal</th></tr></thead><tbody>${items}</tbody></table>
    <table class="totals" style="width:300px;margin-left:auto;margin-top:12px">
      <tr><td>Subtotal</td><td class="n">${money(q.subtotal)}</td></tr>
      ${q.discount ? `<tr><td>Descuento</td><td class="n">-${money(q.discount)}</td></tr>` : ''}
      <tr><td><b style="font-size:15px">TOTAL</b></td><td class="n"><b style="font-size:15px">${money(q.total)}</b></td></tr></table>
    ${q.notes ? `<p><b>Observaciones:</b> ${esc(q.notes)}</p>` : ''}
    ${conditions ? `<p class="muted" style="margin-top:16px;white-space:pre-line">${esc(conditions)}</p>` : ''}
    <p class="muted" style="margin-top:24px">Presupuesto sin valor fiscal. Precios sujetos a disponibilidad de stock.</p>
    </body></html>`);
});

module.exports = router;
module.exports._test = { parseNumber, parseCSV, normKey };
