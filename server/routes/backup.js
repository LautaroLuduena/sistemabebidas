const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const JSZip = require('jszip');
const Database = require('better-sqlite3');
const { db, UPLOADS_DIR } = require('../db');
const { HttpError } = require('../services');

const router = express.Router();

// Tablas de datos del negocio. Los usuarios y sesiones NO se tocan al restaurar,
// para no dejar afuera a quien está restaurando.
const DATA_TABLES = [
  'settings',
  'categories',
  'price_lists',
  'products',
  'product_prices',
  'customers',
  'suppliers',
  'sales',
  'sale_items',
  'purchases',
  'purchase_items',
  'cash_movements',
  'account_movements',
  'stock_movements',
  'quotes',
  'quote_items',
];
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bebidas-'));
const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** Descarga un .zip con la base de datos y todas las fotos. */
router.get('/backup.zip', async (req, res) => {
  const dir = tmpDir();
  try {
    const dbCopy = path.join(dir, 'sistema.db');
    await db.backup(dbCopy); // copia consistente aunque el sistema esté en uso
    const zip = new JSZip();
    zip.file('data/sistema.db', fs.readFileSync(dbCopy));
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      if (IMAGE_EXT.test(f)) zip.file(`data/uploads/${f}`, fs.readFileSync(path.join(UPLOADS_DIR, f)));
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="respaldo_bebidas_${stamp}.zip"`);
    res.end(buf);
  } finally {
    rmDir(dir);
  }
});

/**
 * Restaura un respaldo: acepta el .zip descargado con "Descargar respaldo", la carpeta `data`
 * comprimida en .zip, o directamente el archivo sistema.db.
 * Reemplaza todos los datos del negocio y agrega las fotos. Mantiene los usuarios actuales.
 */
router.post('/restore', upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Elegí el archivo de respaldo');
  const dir = tmpDir();
  const srcDb = path.join(dir, 'origen.db');
  let photos = 0;
  try {
    const head = fs.readFileSync(req.file.path).subarray(0, 16).toString('latin1');
    if (head.startsWith('SQLite format 3')) {
      fs.copyFileSync(req.file.path, srcDb);
    } else if (head.startsWith('PK')) {
      const zip = await JSZip.loadAsync(fs.readFileSync(req.file.path));
      const entries = Object.values(zip.files).filter((e) => !e.dir && !e.name.includes('__MACOSX'));
      const dbEntry = entries.find((e) => /(^|\/)sistema\.db$/i.test(e.name)) || entries.find((e) => /\.db$/i.test(e.name));
      if (!dbEntry) throw new HttpError(400, 'El .zip no contiene el archivo sistema.db');
      fs.writeFileSync(srcDb, await dbEntry.async('nodebuffer'));
      // Si el sistema se cerró sin guardar del todo, los últimos cambios están en el archivo -wal
      const wal = entries.find((e) => e.name === dbEntry.name + '-wal');
      if (wal) fs.writeFileSync(srcDb + '-wal', await wal.async('nodebuffer'));
      // Fotos: se copian a la carpeta de fotos con el mismo nombre (así los productos las encuentran)
      for (const e of entries) {
        const base = path.basename(e.name);
        if (/(^|\/)uploads\//.test(e.name) && IMAGE_EXT.test(base)) {
          fs.writeFileSync(path.join(UPLOADS_DIR, base), await e.async('nodebuffer'));
          photos++;
        }
      }
    } else {
      throw new HttpError(400, 'El archivo no es un respaldo válido. Subí el .zip o el archivo sistema.db');
    }

    // Abrir el origen aplica el -wal pendiente; luego se valida que sea una base de este sistema
    const src = new Database(srcDb);
    try {
      const tables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
      if (!tables.has('products') || !tables.has('price_lists'))
        throw new HttpError(
          400,
          'El archivo no tiene los datos del sistema. Si subiste solo sistema.db, comprimí en un .zip toda la carpeta data (incluye sistema.db-wal, donde pueden estar los últimos cambios) y subí ese .zip.'
        );
      src.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      src.close();
    }

    const counts = {};
    db.pragma('foreign_keys = OFF');
    db.prepare('ATTACH DATABASE ? AS src').run(srcDb);
    try {
      const srcTables = new Set(db.prepare("SELECT name FROM src.sqlite_master WHERE type = 'table'").all().map((t) => t.name));
      db.transaction(() => {
        for (const t of DATA_TABLES) {
          db.prepare(`DELETE FROM main.${t}`).run();
          if (!srcTables.has(t)) continue;
          const mainCols = db.prepare(`PRAGMA main.table_info(${t})`).all().map((c) => c.name);
          const srcCols = new Set(db.prepare(`PRAGMA src.table_info(${t})`).all().map((c) => c.name));
          const cols = mainCols.filter((c) => srcCols.has(c)).map((c) => `"${c}"`).join(',');
          db.prepare(`INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM src.${t}`).run();
          counts[t] = db.prepare(`SELECT COUNT(*) n FROM main.${t}`).get().n;
        }
        // Las listas de precios no pueden quedar vacías
        if (!db.prepare('SELECT 1 FROM price_lists LIMIT 1').get())
          db.prepare("INSERT INTO price_lists (name, description, markup, is_default) VALUES ('Minorista','Venta al público',50,1)").run();
      })();
    } finally {
      db.prepare('DETACH DATABASE src').run();
      db.pragma('foreign_keys = ON');
    }

    res.json({
      ok: true,
      products: counts.products || 0,
      customers: counts.customers || 0,
      suppliers: counts.suppliers || 0,
      sales: counts.sales || 0,
      purchases: counts.purchases || 0,
      photos,
    });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
    rmDir(dir);
  }
});

module.exports = router;
