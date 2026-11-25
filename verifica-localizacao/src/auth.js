'use strict';
// Autenticação por senha única, com cookie de sessão assinado (sem guardar sessão no banco).
const crypto = require('node:crypto');
const DAY = 86400000;
const COOKIE = 'vl_sess';

const secret = () => process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'dev-secret-troque';
const sign = (exp) => crypto.createHmac('sha256', secret()).update(String(exp)).digest('hex');

function makeToken(ttl = 30 * DAY) {
  const exp = Date.now() + ttl;
  return `${exp}.${sign(exp)}`;
}

function validToken(tok) {
  const [exp, mac] = String(tok || '').split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return mac.length === good.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good));
}

function checkPassword(pw) {
  const want = process.env.ADMIN_PASSWORD || '';
  if (!want) return false;
  const a = Buffer.from(String(pw ?? ''));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSession(res, token) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax${secure}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

const isAuthed = (req) => validToken(parseCookies(req)[COOKIE]);
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Não autenticado' });
}

module.exports = { COOKIE, makeToken, validToken, checkPassword, parseCookies, setSession, clearSession, isAuthed, requireAuth };
