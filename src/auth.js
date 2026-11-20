'use strict';
const crypto = require('node:crypto');
const { randomToken } = require('./db');

const COOKIE = 'sid';
const SESSION_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
}

function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, active: u.active, created_at: u.created_at });

async function createUser(db, { name, email, password, role = 'affiliate', phone = '' }) {
  name = String(name || '').trim();
  email = String(email || '').trim().toLowerCase();
  if (!name) throw Object.assign(new Error('Informe o nome'), { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error('E-mail inválido'), { status: 400 });
  if (!password || String(password).length < 6) throw Object.assign(new Error('A senha deve ter pelo menos 6 caracteres'), { status: 400 });
  if (await db.one('SELECT 1 FROM users WHERE email=$1', [email])) throw Object.assign(new Error('Já existe uma conta com este e-mail'), { status: 400 });
  return db.one(`INSERT INTO users(name, email, phone, password_hash, role, inbound_token, signup_slug)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [name, email, String(phone || ''), hashPassword(password), role, randomToken(16), randomToken(6)]);
}

async function createSession(db, res, req, userId) {
  const token = randomToken(32);
  await db.query("INSERT INTO sessions(token, user_id, expires_at) VALUES ($1,$2, now() + interval '30 days')", [token, userId]);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

async function currentUser(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  return db.one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at > now() AND u.active', [token]);
}

const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(ip, a);
  return a.length >= 10;
}

function routes(app, db) {
  app.get('/api/auth/status', async (req, res) => {
    const configured = !!(await db.one('SELECT 1 FROM users LIMIT 1'));
    const u = await currentUser(db, req);
    res.json({ configured, authenticated: !!u, user: publicUser(u) });
  });

  // Primeiro acesso: cria a conta central (administrador).
  app.post('/api/auth/setup', async (req, res) => {
    if (await db.one('SELECT 1 FROM users LIMIT 1')) return res.status(400).json({ error: 'O sistema já foi configurado' });
    const u = await createUser(db, { ...req.body, role: 'admin' });
    await createSession(db, res, req, u.id);
    res.json({ ok: true, user: publicUser(u) });
  });

  app.post('/api/auth/login', async (req, res) => {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const u = await db.one('SELECT * FROM users WHERE email=$1', [email]);
    if (!u || !verifyPassword(req.body?.password || '', u.password_hash)) {
      attempts.set(req.ip, [...(attempts.get(req.ip) || []), Date.now()]);
      return res.status(401).json({ error: 'E-mail ou senha incorretos' });
    }
    if (!u.active) return res.status(403).json({ error: 'Conta desativada. Fale com o administrador.' });
    await createSession(db, res, req, u.id);
    res.json({ ok: true, user: publicUser(u) });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) await db.query('DELETE FROM sessions WHERE token=$1', [token]);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });
}

function requireAuth(db) {
  return async (req, res, next) => {
    try {
      const u = await currentUser(db, req);
      if (!u) return res.status(401).json({ error: 'Não autenticado' });
      req.user = u;
      next();
    } catch (e) { next(e); }
  };
}

module.exports = { routes, requireAuth, hashPassword, verifyPassword, createUser, publicUser };
