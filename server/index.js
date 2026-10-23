const path = require('path');
const express = require('express');
const multer = require('multer');
const { UPLOADS_DIR } = require('./db');
const { HttpError } = require('./services');
const catalog = require('./routes/catalog');
const { customers, suppliers } = require('./routes/parties');
const { sales, purchases, quotes, remitos } = require('./routes/operations');
const cash = require('./routes/cash');
const reports = require('./routes/reports');
const files = require('./routes/files');
const auth = require('./auth');
const backup = require('./routes/backup');
const history = require('./routes/history');
const { publicShop, shopAdmin } = require('./routes/shop');
const whatsapp = require('./routes/whatsapp');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // detrás de un proxy HTTPS (Railway, Render, etc.)
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => {
    if (!req.body) req.body = {};
    next();
  });
  // no-cache: el navegador revalida en cada carga, así siempre toma la última versión después de actualizar
  app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  // Tienda online pública para clientes
  app.get('/tienda', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'tienda.html')));
  app.use('/uploads', auth.requireAuth, express.static(UPLOADS_DIR, { maxAge: '7d' }));

  const api = express.Router();
  api.get('/health', (req, res) => res.json({ ok: true }));
  api.use(auth.router); // login / setup (sin sesión)
  api.use(reports.publicRouter); // nombre y logo del negocio (sin sesión)
  api.use('/shop', publicShop); // catálogo y pedidos de la tienda online (sin sesión)
  api.use(auth.requireAuth);
  api.use('/users', auth.users);
  api.use(backup);
  api.use(history);
  api.use(shopAdmin);
  api.use('/wa-templates', whatsapp);
  api.use(files); // primero, para que /products/export.xlsx no choque con /products/:id
  api.use(catalog);
  api.use('/customers', customers);
  api.use('/suppliers', suppliers);
  api.use('/sales', sales);
  api.use('/quotes', quotes);
  api.use('/remitos', remitos);
  api.use('/purchases', purchases);
  api.use('/cash', cash);
  api.use(reports);
  api.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err instanceof HttpError ? err.status : 500;
    let message = err.message || 'Error interno';
    if (err && err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      status = 409;
      message = 'No se puede completar: este dato está siendo usado en otros registros (ventas, compras, presupuestos, etc.).';
    }
    if (err instanceof multer.MulterError) {
      status = 400;
      message = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo es demasiado grande' : message;
    }
    if (status === 500) console.error(err);
    res.status(status).json({ error: message });
  });
  return app;
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    console.warn('ATENCIÓN: no hay un volumen de Railway montado. Los datos se perderán en cada actualización. Agregá un volumen en /data.');
  }
  createApp().listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ETL Bebidas funcionando en http://localhost:${PORT}\n`);
  });
}

module.exports = { createApp };
