'use strict';
const crypto = require('node:crypto');
const { getSettings, setSettings } = require('./db');

const COOKIE = 'sid';
const SESSION_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
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

function isConfigured(db) {
  return !!getSettings(db).password_hash;
}

function createSession(db, res, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(token, expires_at) VALUES (?, ?)').run(token, expires);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function isAuthenticated(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token=?').get(token);
  return !!row && row.expires_at > new Date().toISOString();
}

// Limite simples de tentativas de login por IP.
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(ip, a);
  return a.length >= 10;
}
function recordFailure(ip) {
  attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);
}

function routes(app, db) {
  app.get('/api/auth/status', (req, res) => {
    res.json({ configured: isConfigured(db), authenticated: isAuthenticated(db, req) });
  });

  app.post('/api/auth/setup', (req, res) => {
    if (isConfigured(db)) return res.status(400).json({ error: 'Senha já configurada' });
    const { password } = req.body || {};
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    setSettings(db, { password_hash: hashPassword(password) });
    createSession(db, res, req);
    res.json({ ok: true });
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip;
    if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
    const { password } = req.body || {};
    if (!verifyPassword(password || '', getSettings(db).password_hash)) {
      recordFailure(ip);
      return res.status(401).json({ error: 'Senha incorreta' });
    }
    createSession(db, res, req);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });
}

function requireAuth(db) {
  return (req, res, next) => {
    if (isAuthenticated(db, req)) return next();
    res.status(401).json({ error: 'Não autenticado' });
  };
}

module.exports = { routes, requireAuth, hashPassword, verifyPassword };
