const path = require('path');
const express = require('express');
const multer = require('multer');
const { UPLOADS_DIR } = require('./db');
const { HttpError } = require('./services');
const catalog = require('./routes/catalog');
const { customers, suppliers } = require('./routes/parties');
const { sales, purchases, quotes } = require('./routes/operations');
const cash = require('./routes/cash');
const reports = require('./routes/reports');
const files = require('./routes/files');
const auth = require('./auth');
const backup = require('./routes/backup');

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
  app.use('/uploads', auth.requireAuth, express.static(UPLOADS_DIR, { maxAge: '7d' }));

  const api = express.Router();
  api.get('/health', (req, res) => res.json({ ok: true }));
  api.use(auth.router); // login / setup (sin sesión)
  api.use(auth.requireAuth);
  api.use('/users', auth.users);
  api.use(backup);
  api.use(files); // primero, para que /products/export.xlsx no choque con /products/:id
  api.use(catalog);
  api.use('/customers', customers);
  api.use('/suppliers', suppliers);
  api.use('/sales', sales);
  api.use('/quotes', quotes);
  api.use('/purchases', purchases);
  api.use('/cash', cash);
  api.use(reports);
  api.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err instanceof HttpError ? err.status : 500;
    let message = err.message || 'Error interno';
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
    console.log(`\n  Sistema Bebidas funcionando en http://localhost:${PORT}\n`);
  });
}

module.exports = { createApp };
