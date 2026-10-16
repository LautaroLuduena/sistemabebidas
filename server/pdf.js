/**
 * Generación de PDF reales (presupuestos, comprobantes de venta y listas de precios).
 * Se arman en el servidor para que la descarga funcione igual en PC y celular,
 * sin depender del "Imprimir → Guardar como PDF" del navegador.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { UPLOADS_DIR } = require('./db');
const { getSetting, logoFile } = require('./services');

const MARGIN = 40;
const DARK = '#111111';
const MUTED = '#666666';
const LINE = '#dddddd';
const HEAD_BG = '#f1f5f9';

const money = (n) =>
  '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toLocaleString('es-AR'));
const fmtDate = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');

/** Ruta de una imagen subida si pdfkit la puede usar (JPG o PNG). */
function imagePath(filename) {
  if (!filename || !/\.(jpe?g|png)$/i.test(filename)) return null;
  const p = path.join(UPLOADS_DIR, path.basename(filename));
  return fs.existsSync(p) ? p : null;
}

function business() {
  return {
    name: getSetting('business_name') || '',
    contact: [getSetting('business_address'), getSetting('business_phone'), getSetting('business_tax_id') && `CUIT ${getSetting('business_tax_id')}`]
      .filter(Boolean)
      .join('  ·  '),
    logo: logoFile(),
  };
}

function newDoc(res, filename, title) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: title }, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}

const contentWidth = (doc) => doc.page.width - MARGIN * 2;

/** Encabezado: logo + datos del negocio a la izquierda, título y datos del comprobante a la derecha. */
function header(doc, title, rightLines = []) {
  const b = business();
  const top = MARGIN;
  let x = MARGIN;
  if (b.logo) {
    try {
      doc.image(b.logo, MARGIN, top, { fit: [100, 56] });
      x = MARGIN + 110;
    } catch {
      /* imagen inválida: se omite */
    }
  }
  doc.fillColor(DARK).font('Helvetica-Bold').fontSize(18).text(b.name, x, top + 4, { width: 260 });
  if (b.contact) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(b.contact, x, doc.y + 2, { width: 260 });

  const rx = doc.page.width - MARGIN - 220;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text(title, rx, top + 4, { width: 220, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  for (const l of rightLines) {
    // Ojo: los strings tienen un método .bold(), por eso se pregunta por objeto
    if (l && typeof l === 'object') doc.font('Helvetica-Bold').fillColor(l.color || DARK).text(l.text, rx, doc.y + 1, { width: 220, align: 'right' });
    else if (l) doc.font('Helvetica').fillColor(MUTED).text(l, rx, doc.y + 1, { width: 220, align: 'right' });
  }
  const bottom = Math.max(top + 60, doc.y + 8);
  doc.moveTo(MARGIN, bottom).lineTo(doc.page.width - MARGIN, bottom).lineWidth(1.5).strokeColor(DARK).stroke();
  doc.y = bottom + 10;
  doc.x = MARGIN;
}

/** Tabla simple con salto de página y encabezado repetido. columns: [{label, width, align, key|render, image}] */
function table(doc, columns, rows, { rowHeight = 18, groupKey, groupLabel } = {}) {
  const total = columns.reduce((a, c) => a + c.width, 0);
  const scale = contentWidth(doc) / total;
  const cols = columns.map((c) => ({ ...c, w: c.width * scale }));
  const pageBottom = () => doc.page.height - MARGIN - 20;

  const drawHead = () => {
    const y = doc.y;
    doc.rect(MARGIN, y, contentWidth(doc), 18).fill(HEAD_BG);
    let x = MARGIN;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#333333');
    for (const c of cols) {
      doc.text(c.label.toUpperCase(), x + 3, y + 5.5, { width: c.w - 6, align: c.align || 'left', height: 10, ellipsis: true });
      x += c.w;
    }
    doc.y = y + 18;
  };

  drawHead();
  let lastGroup;
  for (const row of rows) {
    if (groupKey && row[groupKey] !== lastGroup) {
      lastGroup = row[groupKey];
      if (doc.y + 20 + rowHeight > pageBottom()) {
        doc.addPage();
        drawHead();
      }
      const y = doc.y;
      doc.rect(MARGIN, y, contentWidth(doc), 18).fill(DARK);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#ffffff').text(groupLabel(row), MARGIN + 6, y + 5, { lineBreak: false });
      doc.y = y + 20;
    }
    // Alto de la fila según el texto más largo
    doc.font('Helvetica').fontSize(9);
    let h = rowHeight;
    for (const c of cols) {
      if (c.image) continue;
      const v = String(c.render ? c.render(row) : row[c.key] ?? '');
      h = Math.max(h, doc.heightOfString(v, { width: c.w - 8 }) + 8);
    }
    if (doc.y + h > pageBottom()) {
      doc.addPage();
      drawHead();
    }
    const y = doc.y;
    let x = MARGIN;
    for (const c of cols) {
      if (c.image) {
        const img = imagePath(c.image(row));
        if (img) {
          try {
            doc.image(img, x + 3, y + 2, { fit: [c.w - 6, h - 4], align: 'center', valign: 'center' });
          } catch {
            /* imagen inválida */
          }
        }
      } else {
        const v = String(c.render ? c.render(row) : row[c.key] ?? '');
        doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(DARK);
        doc.text(v, x + 4, y + 5, { width: c.w - 8, align: c.align || 'left' });
      }
      x += c.w;
    }
    doc.y = y + h;
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + contentWidth(doc), doc.y).lineWidth(0.5).strokeColor(LINE).stroke();
  }
  doc.x = MARGIN;
}

/** Bloque de totales alineado a la derecha. lines: [[label, value, bold?]] */
function totals(doc, lines) {
  const w = 230;
  const x = doc.page.width - MARGIN - w;
  if (doc.y + lines.length * 18 + 10 > doc.page.height - MARGIN - 20) doc.addPage();
  doc.y += 8;
  for (const [label, value, bold] of lines) {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 9.5).fillColor(DARK);
    doc.text(label, x, y, { width: w / 2 });
    doc.text(value, x + w / 2, y, { width: w / 2, align: 'right' });
    doc.y = y + (bold ? 20 : 15);
  }
  doc.x = MARGIN;
}

function paragraph(doc, text, { bold, muted, size = 9.5, gap = 8 } = {}) {
  if (!text) return;
  doc.y += gap;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(muted ? MUTED : DARK);
  doc.text(text, MARGIN, doc.y, { width: contentWidth(doc) });
}

function customerBlock(doc, name, extra = []) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text('Cliente: ', MARGIN, doc.y, { continued: true });
  doc.font('Helvetica').text(name || 'Consumidor final');
  for (const [label, value] of extra) {
    if (!value) continue;
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true }).font('Helvetica').text(value);
  }
  doc.y += 8;
}

/** Número de página al pie */
function footerPages(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // escribir en el margen inferior sin que pdfkit agregue otra hoja
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    doc.text(`Página ${i + 1} de ${range.count}`, MARGIN, doc.page.height - MARGIN + 5, {
      width: contentWidth(doc),
      align: 'right',
      lineBreak: false,
    });
  }
}

// ---------------------------------------------------------------------------

function quotePdf(res, q, { photos } = {}) {
  const num = String(q.id).padStart(6, '0');
  const doc = newDoc(res, `presupuesto_${num}.pdf`, `Presupuesto ${num}`);
  const status =
    q.status === 'anulado'
      ? { text: 'ANULADO', bold: true, color: '#b91c1c' }
      : q.status === 'vendido'
        ? { text: `CONVERTIDO EN VENTA #${q.sale_id}`, bold: true, color: '#15803d' }
        : null;
  header(doc, `PRESUPUESTO N° ${num}`, [`Fecha: ${fmtDate(q.date)}`, q.valid_until && { text: `Válido hasta: ${fmtDate(q.valid_until)}`, bold: true }, status]);
  customerBlock(doc, q.customer_name, [
    ['CUIT/DNI', q.customer_tax_id],
    ['Dirección', q.customer_address],
    ['Teléfono', q.customer_phone],
  ]);
  const cols = [
    ...(photos ? [{ label: '', width: 50, image: (r) => r.image }] : []),
    { label: 'Producto', width: 260, key: 'description' },
    { label: 'Cant.', width: 50, align: 'right', render: (r) => qty(r.quantity) },
    { label: 'P. unit.', width: 90, align: 'right', render: (r) => money(r.unit_price) },
    { label: 'Subtotal', width: 90, align: 'right', render: (r) => money(r.subtotal), bold: true },
  ];
  table(doc, cols, q.items, { rowHeight: photos ? 40 : 18 });
  totals(doc, [
    ['Subtotal', money(q.subtotal)],
    ...(q.discount ? [['Descuento', '-' + money(q.discount)]] : []),
    ['TOTAL', money(q.total), true],
  ]);
  if (q.notes) paragraph(doc, `Observaciones: ${q.notes}`);
  paragraph(doc, getSetting('quote_footer'), { muted: true, gap: 12 });
  paragraph(doc, 'Presupuesto sin valor fiscal. Precios sujetos a disponibilidad de stock.', { muted: true, size: 8, gap: 16 });
  footerPages(doc);
  doc.end();
}

function salePdf(res, s) {
  const doc = newDoc(res, `venta_${s.id}.pdf`, `Venta ${s.id}`);
  header(doc, `COMPROBANTE DE VENTA N° ${s.id}`, [
    `Fecha: ${fmtDate(s.date)} ${String(s.date).slice(11, 16)}`,
    s.status === 'anulada' && { text: 'ANULADA', bold: true, color: '#b91c1c' },
  ]);
  customerBlock(doc, s.customer_name, [
    ['CUIT/DNI', s.customer_tax_id],
    ['Dirección', s.customer_address],
    ['Lista', s.price_list_name],
  ]);
  table(doc, [
    { label: 'Producto', width: 270, key: 'description' },
    { label: 'Cant.', width: 50, align: 'right', render: (r) => qty(r.quantity) },
    { label: 'P. unit.', width: 90, align: 'right', render: (r) => money(r.unit_price) },
    { label: 'Subtotal', width: 90, align: 'right', render: (r) => money(r.subtotal), bold: true },
  ], s.items);
  totals(doc, [
    ['Subtotal', money(s.subtotal)],
    ...(s.discount ? [['Descuento', '-' + money(s.discount)]] : []),
    ['TOTAL', money(s.total), true],
    ...(s.paid_cash ? [['Efectivo', money(s.paid_cash)]] : []),
    ...(s.paid_transfer ? [['Transferencia', money(s.paid_transfer)]] : []),
    ...(s.on_account ? [['Cuenta corriente', money(s.on_account)]] : []),
  ]);
  if (s.notes) paragraph(doc, `Notas: ${s.notes}`);
  paragraph(doc, 'Documento no válido como factura.', { muted: true, size: 8, gap: 16 });
  footerPages(doc);
  doc.end();
}

function priceListPdf(res, list, rows, { photos, layout, customerName, filename }) {
  const doc = newDoc(res, filename, `Lista de precios ${list.name}`);
  header(doc, 'LISTA DE PRECIOS', [
    { text: list.name, bold: true },
    customerName && `Cliente: ${customerName}`,
    `${new Date().toLocaleDateString('es-AR')}  ·  ${rows.length} productos`,
  ]);
  if (layout === 'catalogo') {
    // Grilla de tarjetas con foto, 4 por fila
    const perRow = 4;
    const gap = 8;
    const w = (contentWidth(doc) - gap * (perRow - 1)) / perRow;
    const h = 150;
    let col = 0;
    let lastCat;
    for (const r of rows) {
      if (r.category !== lastCat) {
        if (col !== 0) doc.y += h + gap;
        col = 0;
        lastCat = r.category;
        if (doc.y + 24 + h > doc.page.height - MARGIN - 20) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(12).fillColor(DARK).text(r.category || 'Sin categoría', MARGIN, doc.y + 4);
        doc.y += 6;
      }
      if (col === 0 && doc.y + h > doc.page.height - MARGIN - 20) doc.addPage();
      const x = MARGIN + col * (w + gap);
      const y = doc.y;
      doc.roundedRect(x, y, w, h, 4).lineWidth(0.5).strokeColor(LINE).stroke();
      const img = imagePath(r.image);
      if (img) {
        try {
          doc.image(img, x + 6, y + 6, { fit: [w - 12, 70], align: 'center', valign: 'center' });
        } catch {
          /* imagen inválida */
        }
      }
      doc.font('Helvetica').fontSize(8.5).fillColor(DARK).text(r.name, x + 6, y + 80, { width: w - 12, align: 'center', height: 22, ellipsis: true });
      if (r.presentation) doc.fontSize(7.5).fillColor(MUTED).text(r.presentation, x + 6, y + 102, { width: w - 12, align: 'center', lineBreak: false, ellipsis: true });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(money(r.price), x + 6, y + 115, { width: w - 12, align: 'center' });
      if (r.pack_price)
        doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`Bulto x${r.units_per_pack}: ${money(r.pack_price)}`, x + 6, y + 132, { width: w - 12, align: 'center' });
      col++;
      if (col === perRow) {
        col = 0;
        doc.y = y + h + gap;
      } else doc.y = y;
    }
    if (col !== 0) doc.y += h + gap;
  } else {
    table(
      doc,
      [
        ...(photos ? [{ label: '', width: 45, image: (r) => r.image }] : []),
        { label: 'Código', width: 65, render: (r) => r.code || r.barcode || '' },
        { label: 'Producto', width: 200, key: 'name' },
        { label: 'Presentación', width: 85, render: (r) => r.presentation || '' },
        { label: 'Precio unit.', width: 80, align: 'right', render: (r) => money(r.price), bold: true },
        { label: 'Bulto', width: 45, align: 'right', render: (r) => (r.units_per_pack > 1 ? 'x' + r.units_per_pack : '') },
        { label: 'Precio bulto', width: 90, align: 'right', render: (r) => (r.pack_price ? money(r.pack_price) : '') },
      ],
      rows,
      { rowHeight: photos ? 36 : 18, groupKey: 'category', groupLabel: (r) => r.category || 'Sin categoría' }
    );
  }
  paragraph(doc, getSetting('price_list_footer'), { muted: true, gap: 14 });
  footerPages(doc);
  doc.end();
}

module.exports = { quotePdf, salePdf, priceListPdf };
