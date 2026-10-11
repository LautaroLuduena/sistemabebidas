const crypto = require('crypto');
const express = require('express');
const { db } = require('./db');
const { HttpError } = require('./services');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`);

const COOKIE = 'sb_session';
const SESSION_DAYS = 30;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === test.length && crypto.timingSafeEqual(expected, test);
}

function validateCredentials(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  if (username.length < 3) throw new HttpError(400, 'El usuario debe tener al menos 3 caracteres');
  if (password.length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres');
  return { username, password };
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
  return out;
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      'SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
    )
    .get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username };
}

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(token), userId, expires);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`
  );
}

// Freno simple a intentos de login por IP
const attempts = new Map();
function checkRate(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { count: 0, until: 0 };
  if (a.until > now) throw new HttpError(429, 'Demasiados intentos. Esperá un minuto y volvé a probar.');
  return a;
}
function failAttempt(ip, a) {
  a.count += 1;
  if (a.count >= 5) {
    a.count = 0;
    a.until = Date.now() + 60_000;
  }
  attempts.set(ip, a);
}

const usersCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;

const router = express.Router();

router.get('/auth/status', (req, res) => {
  res.json({ setup_needed: usersCount() === 0, user: currentUser(req) });
});

/** Primer uso: crea el usuario administrador. Solo funciona si todavía no hay usuarios. */
router.post('/auth/setup', (req, res) => {
  if (usersCount() > 0) throw new HttpError(403, 'El sistema ya tiene usuarios');
  const { username, password } = validateCredentials(req.body.username, req.body.password);
  const id = db.prepare('INSERT INTO users (username, password_hash) VALUES (?,?)').run(username, hashPassword(password))
    .lastInsertRowid;
  startSession(req, res, id);
  res.status(201).json({ ok: true });
});

router.post('/auth/login', (req, res) => {
  const a = checkRate(req.ip);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username || '').trim());
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    failAttempt(req.ip, a);
    throw new HttpError(401, 'Usuario o contraseña incorrectos');
  }
  attempts.delete(req.ip);
  startSession(req, res, user.id);
  res.json({ ok: true });
});

router.post('/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

/** Middleware: todo lo que no sea /auth/* requiere sesión iniciada. */
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    if (req.accepts(['json', 'html']) === 'html' && req.method === 'GET') return res.redirect('/');
    return res.status(401).json({ error: 'Tenés que iniciar sesión' });
  }
  req.user = user;
  next();
}

// ---------- Gestión de usuarios (requiere sesión) ----------
const users = express.Router();

users.get('/', (req, res) => {
  res.json(db.prepare('SELECT id, username, created_at FROM users ORDER BY username').all());
});

users.post('/', (req, res) => {
  const { username, password } = validateCredentials(req.body.username, req.body.password);
  try {
    const r = db.prepare('INSERT INTO users (username, password_hash) VALUES (?,?)').run(username, hashPassword(password));
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe un usuario con ese nombre');
    throw e;
  }
});

users.put('/:id/password', (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres');
  const r = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.params.id);
  if (!r.changes) throw new HttpError(404, 'Usuario no encontrado');
  // Cierra las otras sesiones de ese usuario
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  if (Number(req.params.id) === req.user.id) startSession(req, res, req.user.id);
  res.json({ ok: true });
});

users.delete('/:id', (req, res) => {
  if (Number(req.params.id) === req.user.id) throw new HttpError(400, 'No podés eliminar tu propio usuario');
  if (usersCount() <= 1) throw new HttpError(400, 'Debe quedar al menos un usuario');
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = { router, requireAuth, users };
