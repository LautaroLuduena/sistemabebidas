const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'sistema.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS price_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  markup REAL NOT NULL DEFAULT 0,          -- % sobre el costo, usado cuando el producto no tiene precio fijo
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  brand TEXT,
  presentation TEXT,                        -- ej: "Lata 473ml", "Botella 1.5L"
  units_per_pack INTEGER NOT NULL DEFAULT 1, -- unidades por bulto / pack
  cost REAL NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  image TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS product_prices (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  price REAL NOT NULL,
  PRIMARY KEY (product_id, price_list_id)
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tax_id TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  price_list_id INTEGER REFERENCES price_lists(id) ON DELETE SET NULL,
  credit_limit REAL NOT NULL DEFAULT 0,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tax_id TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  customer_id INTEGER REFERENCES customers(id),
  price_list_id INTEGER REFERENCES price_lists(id),
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  paid_cash REAL NOT NULL DEFAULT 0,
  paid_transfer REAL NOT NULL DEFAULT 0,
  on_account REAL NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ok'          -- ok | anulada
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  supplier_id INTEGER REFERENCES suppliers(id),
  invoice_number TEXT,
  total REAL NOT NULL DEFAULT 0,
  paid_cash REAL NOT NULL DEFAULT 0,
  paid_transfer REAL NOT NULL DEFAULT 0,
  on_account REAL NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL,
  subtotal REAL NOT NULL
);

-- Caja: dos cajas, 'efectivo' y 'transferencia'. amount > 0 ingreso, < 0 egreso.
CREATE TABLE IF NOT EXISTS cash_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  box TEXT NOT NULL CHECK (box IN ('efectivo','transferencia')),
  amount REAL NOT NULL,
  concept TEXT NOT NULL,
  ref_type TEXT,                              -- venta | compra | cobro | pago | manual | traspaso
  ref_id INTEGER
);

-- Cuenta corriente. amount > 0 aumenta la deuda (cliente nos debe / le debemos al proveedor), < 0 la reduce.
CREATE TABLE IF NOT EXISTS account_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  party_type TEXT NOT NULL CHECK (party_type IN ('cliente','proveedor')),
  party_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  concept TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity REAL NOT NULL,
  type TEXT NOT NULL,                         -- venta | compra | ajuste | importacion | anulacion | inicial
  ref_id INTEGER,
  notes TEXT
);

-- Presupuestos: no mueven stock, caja ni cuenta corriente hasta que se pasan a venta
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT,                         -- para presupuestos a alguien que no es cliente cargado
  price_list_id INTEGER REFERENCES price_lists(id),
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  valid_until TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente | vendido | anulado
  sale_id INTEGER REFERENCES sales(id)
);

CREATE TABLE IF NOT EXISTS quote_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  subtotal REAL NOT NULL
);

-- Remitos X (documento no válido como factura). Se generan a partir de una venta:
-- el stock ya lo descontó la venta, el remito documenta la entrega.
CREATE TABLE IF NOT EXISTS remitos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pv INTEGER NOT NULL DEFAULT 1,              -- punto de venta (0001)
  number INTEGER NOT NULL,                    -- número correlativo dentro del punto de venta
  date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  delivery_address TEXT,
  notes TEXT,
  valued INTEGER NOT NULL DEFAULT 1,          -- 1 = muestra precios, 0 = solo cantidades
  status TEXT NOT NULL DEFAULT 'emitido',     -- emitido | anulado
  UNIQUE (pv, number)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_cash_box ON cash_movements(box, date);
CREATE INDEX IF NOT EXISTS idx_account_party ON account_movements(party_type, party_id, date);
CREATE INDEX IF NOT EXISTS idx_stock_product ON stock_movements(product_id, date);
`);

// Datos iniciales: listas de precios típicas de una distribuidora
if (db.prepare('SELECT COUNT(*) n FROM price_lists').get().n === 0) {
  const ins = db.prepare('INSERT INTO price_lists (name, description, markup, is_default) VALUES (?,?,?,?)');
  ins.run('Minorista', 'Venta al público', 50, 1);
  ins.run('Mayorista', 'Venta por bulto a comercios', 25, 0);
}

db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('business_name', 'ETL Bebidas')").run();
// Instalaciones que todavía tienen un nombre provisorio pasan a llamarse ETL Bebidas
db.prepare(
  "UPDATE settings SET value = 'ETL Bebidas' WHERE key = 'business_name' AND value IN ('Mi Distribuidora de Bebidas', 'Distrimax')"
).run();

// Migraciones de columnas agregadas después (bases ya existentes)
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('quotes', 'source', "TEXT NOT NULL DEFAULT 'interno'"); // interno | web (pedido desde la tienda online)
addColumn('quotes', 'contact_phone', 'TEXT');
addColumn('quotes', 'contact_address', 'TEXT');
addColumn('customers', 'shop_token', 'TEXT');
addColumn('quotes', 'status_changed_at', 'TEXT');
addColumn('price_lists', 'min_order', 'REAL NOT NULL DEFAULT 0');
// Seguimiento de la tienda online: de qué canal vienen (origen) y de qué localidad son los clientes
addColumn('quotes', 'origin', 'TEXT');
addColumn('quotes', 'contact_city', 'TEXT');
addColumn('customers', 'city', 'TEXT');
addColumn('suppliers', 'city', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS shop_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  origin TEXT NOT NULL DEFAULT 'directo'
)`); // pedido mínimo en la tienda online para esa lista
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_shop_token ON customers(shop_token)');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

module.exports = { db, round2, DATA_DIR, UPLOADS_DIR };
