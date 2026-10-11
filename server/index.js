const path = require('path');
const express = require('express');
const multer = require('multer');
const { UPLOADS_DIR } = require('./db');
const { HttpError } = require('./services');
const catalog = require('./routes/catalog');
const { customers, suppliers } = require('./routes/parties');
const { sales, purchases } = require('./routes/operations');
const cash = require('./routes/cash');
const reports = require('./routes/reports');
const files = require('./routes/files');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => {
    if (!req.body) req.body = {};
    next();
  });
  app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const api = express.Router();
  api.use(files); // primero, para que /products/export.xlsx no choque con /products/:id
  api.use(catalog);
  api.use('/customers', customers);
  api.use('/suppliers', suppliers);
  api.use('/sales', sales);
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
  createApp().listen(PORT, () => {
    console.log(`\n  Sistema Bebidas funcionando en http://localhost:${PORT}\n`);
  });
}

module.exports = { createApp };
