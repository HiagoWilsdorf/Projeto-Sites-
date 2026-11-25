'use strict';
const path = require('node:path');
const express = require('express');
const DB = require('./db');
const geo = require('./geo');
const auth = require('./auth');

const APP_NAME = () => process.env.APP_NAME || 'Verifica Localização';
const CONSENT_TEXT = 'Autorizo o registro da minha localização (aproximada por IP e, se eu permitir no navegador, precisa por GPS) para confirmação de dados.';

const str = (v, max = 400) => String(v ?? '').trim().slice(0, max);
const int = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.round(Number(v)) : d);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const notFound = (m = 'Registro não encontrado') => new HttpError(404, m);

/** Monta link de "clique para conversar" no WhatsApp com a mensagem pronta. */
function waLink(phone, text) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length <= 11) d = '55' + d.replace(/^0+/, ''); // DDI Brasil por padrão
  return `https://wa.me/${d}?text=${encodeURIComponent(text || '')}`;
}

function siteUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return `${req.protocol}://${req.get('host')}`;
}

function createApp(opts = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  let dbPromise = opts.db ? Promise.resolve(opts.db) : null;
  const getDb = () => (dbPromise ||= DB.connect().catch((e) => { dbPromise = null; throw e; }));
  let db;

  const pub = path.join(__dirname, '..', 'public');
  app.use(express.json({ limit: '256kb' }));

  const isExpired = (c) => new Date(c.expires_at).getTime() < Date.now();

  function view(c) {
    const expired = c.status === 'pending' && isExpired(c);
    return {
      id: c.id, token: c.token, label: c.label, phone: c.phone, purpose: c.purpose,
      status: expired ? 'expired' : c.status, consent: c.consent,
      ip: c.ip, ip_place: [c.ip_city, c.ip_region, c.ip_country].filter(Boolean).join(', ') || null, ip_org: c.ip_org,
      gps_lat: c.gps_lat, gps_lng: c.gps_lng, gps_accuracy: c.gps_accuracy, gps_address: c.gps_address,
      maps_url: (c.gps_lat != null && c.gps_lng != null) ? `https://www.google.com/maps?q=${c.gps_lat},${c.gps_lng}` : null,
      captured_at: c.captured_at, expires_at: c.expires_at, created_at: c.created_at,
    };
  }

  // ===================== Sessão / login =====================
  app.post('/api/login', (req, res) => {
    if (!process.env.ADMIN_PASSWORD) throw new HttpError(500, 'ADMIN_PASSWORD não configurada no servidor.');
    if (!auth.checkPassword(req.body?.password)) throw new HttpError(401, 'Senha incorreta');
    auth.setSession(res, auth.makeToken());
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => res.json({ app_name: APP_NAME(), authenticated: auth.isAuthed(req), configured: !!process.env.ADMIN_PASSWORD }));

  // Conecta o banco sob demanda (serverless). Login/me/logout acima não dependem do banco.
  app.use('/api', async (req, res, next) => { try { db = await getDb(); next(); } catch (e) { next(e); } });

  // ===================== Página pública do destinatário =====================
  async function check(token) {
    const c = await db.one('SELECT * FROM checks WHERE token=$1', [String(token)]);
    if (!c) throw notFound('Link de verificação não encontrado');
    return c;
  }

  app.get('/api/v/:token', async (req, res) => {
    const c = await check(req.params.token);
    const expired = c.status === 'pending' && isExpired(c);
    res.json({ app_name: APP_NAME(), status: expired ? 'expired' : c.status, done: c.status !== 'pending' || expired, purpose: c.purpose || null, consent_text: CONSENT_TEXT });
  });

  app.post('/api/v/:token', async (req, res) => {
    const c = await check(req.params.token);
    if (c.status !== 'pending') throw bad('Este link já foi utilizado.');
    if (isExpired(c)) { await db.query("UPDATE checks SET status='expired' WHERE id=$1", [c.id]); throw bad('Este link expirou.'); }

    const b = req.body || {};
    if (!b.consent) {
      await db.query("UPDATE checks SET status='denied', consent=FALSE, user_agent=$2, captured_at=now() WHERE id=$1", [c.id, str(req.headers['user-agent'], 300)]);
      return res.json({ ok: true, status: 'denied' });
    }

    const ip = geo.ipFromReq(req);
    const ipGeo = await geo.lookupIp(ip).catch(() => null);
    const gLat = geo.num(b.gps?.lat), gLng = geo.num(b.gps?.lng), gAcc = geo.num(b.gps?.accuracy);
    const gpsAddr = (gLat != null && gLng != null) ? await geo.reverseGeocode(gLat, gLng).catch(() => null) : null;

    await db.query(`UPDATE checks SET status='captured', consent=TRUE, consent_text=$2, user_agent=$3,
      ip=$4, ip_city=$5, ip_region=$6, ip_country=$7, ip_lat=$8, ip_lng=$9, ip_org=$10,
      gps_lat=$11, gps_lng=$12, gps_accuracy=$13, gps_address=$14, captured_at=now() WHERE id=$1`,
    [c.id, CONSENT_TEXT, str(req.headers['user-agent'], 300),
      ip || null, ipGeo?.city || null, ipGeo?.region || null, ipGeo?.country || null, ipGeo?.lat ?? null, ipGeo?.lng ?? null, ipGeo?.org || null,
      gLat, gLng, gAcc, gpsAddr ? gpsAddr.slice(0, 400) : null]);

    res.json({ ok: true, status: 'captured' });
  });

  // ===================== Painel (exige login) =====================
  app.post('/api/checks', auth.requireAuth, async (req, res) => {
    const hours = Math.min(168, Math.max(1, int(req.body?.hours, 24)));
    const label = str(req.body?.label, 120) || null;
    const phone = str(req.body?.phone, 30) || null;
    const purpose = str(req.body?.purpose, 300) || null;
    const c = await db.one(`INSERT INTO checks(token, label, phone, purpose, expires_at)
      VALUES ($1,$2,$3,$4, now() + ($5::int * interval '1 hour')) RETURNING *`,
    [DB.randomToken(16), label, phone, purpose, hours]);
    const url = `${siteUrl(req)}/v/${c.token}`;
    const msg = `Olá! ${purpose ? purpose + '\n\n' : ''}Para confirmarmos seus dados, abra o link abaixo e autorize a verificação da sua localização (leva alguns segundos):\n${url}\n\n${APP_NAME()}`;
    res.status(201).json({ ...view(c), url, message: msg, wa_link: waLink(phone, msg) });
  });

  app.get('/api/checks', auth.requireAuth, async (req, res) => {
    const rows = await db.query('SELECT * FROM checks ORDER BY created_at DESC, id DESC LIMIT 200');
    res.json(rows.map(view));
  });

  app.get('/api/checks/:id', auth.requireAuth, async (req, res) => {
    const c = await db.one('SELECT * FROM checks WHERE id=$1', [int(req.params.id)]);
    if (!c) throw notFound();
    const url = `${siteUrl(req)}/v/${c.token}`;
    const msg = `Olá! ${c.purpose ? c.purpose + '\n\n' : ''}Para confirmarmos seus dados, abra o link abaixo e autorize a verificação da sua localização:\n${url}\n\n${APP_NAME()}`;
    res.json({ ...view(c), url, message: msg, wa_link: waLink(c.phone, msg) });
  });

  app.delete('/api/checks/:id', auth.requireAuth, async (req, res) => {
    await db.query('DELETE FROM checks WHERE id=$1', [int(req.params.id)]);
    res.json({ ok: true });
  });

  // ===================== Páginas / estáticos =====================
  // URL amigável do destinatário: /v/<token> serve a página pública.
  app.get('/v/:token', (req, res) => res.sendFile(path.join(pub, 'v.html')));
  app.use(express.static(pub));
  app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));

  // 404 + erros
  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Erro interno' });
  });

  return app;
}

// Exporta uma instância pronta como export padrão (requisito do runtime de função da Vercel),
// mantendo createApp/waLink/siteUrl como propriedades para uso local e nos testes.
const app = createApp();
app.createApp = createApp;
app.waLink = waLink;
app.siteUrl = siteUrl;
module.exports = app;
