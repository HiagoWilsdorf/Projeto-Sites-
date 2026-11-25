'use strict';
const path = require('node:path');
const express = require('express');
const { createStore } = require('./store');
const geo = require('./geo');
const auth = require('./auth');

const APP_NAME = () => process.env.APP_NAME || 'Verifica Localização';
const CONSENT_FIXED = 'Autorizo o registro da minha localização atual (uma vez), por IP e GPS, para confirmação de dados.';
const CONSENT_LIVE = 'Autorizo o compartilhamento da minha localização em tempo real enquanto esta tela estiver aberta. Posso parar quando quiser.';
const LIVE_ONLINE_MS = 60000; // considerada "ao vivo" se atualizou nos últimos 60s

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

  const store = opts.store || createStore();
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.json({ limit: '256kb' }));

  const isExpired = (c) => new Date(c.expires_at).getTime() < Date.now();

  function view(c) {
    const expired = c.status === 'pending' && isExpired(c);
    const liveOnline = !!c.live_updated_at && (Date.now() - new Date(c.live_updated_at).getTime() < LIVE_ONLINE_MS);
    return {
      id: c.id, token: c.token, label: c.label, phone: c.phone, purpose: c.purpose,
      status: expired ? 'expired' : c.status, consent: !!c.consent,
      // Localização fixa (capturada uma vez)
      ip: c.ip, ip_place: [c.ip_city, c.ip_region, c.ip_country].filter(Boolean).join(', ') || null, ip_org: c.ip_org,
      gps_lat: c.gps_lat, gps_lng: c.gps_lng, gps_accuracy: c.gps_accuracy, gps_address: c.gps_address,
      maps_url: (c.gps_lat != null && c.gps_lng != null) ? `https://www.google.com/maps?q=${c.gps_lat},${c.gps_lng}` : null,
      captured_at: c.captured_at, expires_at: c.expires_at, created_at: c.created_at,
      // Localização em tempo real (atualizada enquanto a pessoa compartilha)
      live_consent: !!c.live_consent,
      live_lat: c.live_lat ?? null, live_lng: c.live_lng ?? null, live_accuracy: c.live_accuracy ?? null,
      live_updated_at: c.live_updated_at || null, live_online: liveOnline,
      live_maps_url: (c.live_lat != null && c.live_lng != null) ? `https://www.google.com/maps?q=${c.live_lat},${c.live_lng}` : null,
    };
  }

  // ===================== Sessão / login (não dependem do armazenamento) =====================
  app.post('/api/login', (req, res) => {
    if (!process.env.ADMIN_PASSWORD) throw new HttpError(500, 'ADMIN_PASSWORD não configurada no servidor.');
    if (!auth.checkPassword(req.body?.password)) throw new HttpError(401, 'Senha incorreta');
    auth.setSession(res, auth.makeToken());
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => res.json({ app_name: APP_NAME(), authenticated: auth.isAuthed(req), configured: !!process.env.ADMIN_PASSWORD }));

  // ===================== Página pública do destinatário =====================
  async function check(token) {
    const c = await store.getByToken(token);
    if (!c) throw notFound('Link de verificação não encontrado');
    return c;
  }

  app.get('/api/v/:token', async (req, res) => {
    const c = await check(req.params.token);
    const expired = c.status === 'pending' && isExpired(c);
    res.json({
      app_name: APP_NAME(), status: expired ? 'expired' : c.status, done: c.status !== 'pending' || expired,
      purpose: c.purpose || null, consent_fixed: CONSENT_FIXED, consent_live: CONSENT_LIVE,
    });
  });

  app.post('/api/v/:token', async (req, res) => {
    const c = await check(req.params.token);
    if (c.status !== 'pending') throw bad('Este link já foi utilizado.');
    if (isExpired(c)) { await store.update(c.id, { status: 'expired' }); throw bad('Este link expirou.'); }

    const b = req.body || {};
    if (!b.consent) {
      await store.update(c.id, { status: 'denied', consent: false, user_agent: str(req.headers['user-agent'], 300), captured_at: new Date().toISOString() });
      return res.json({ ok: true, status: 'denied' });
    }

    const ip = geo.ipFromReq(req);
    const ipGeo = await geo.lookupIp(ip).catch(() => null);
    const gLat = geo.num(b.gps?.lat), gLng = geo.num(b.gps?.lng), gAcc = geo.num(b.gps?.accuracy);
    const gpsAddr = (gLat != null && gLng != null) ? await geo.reverseGeocode(gLat, gLng).catch(() => null) : null;
    const liveConsent = !!b.live_consent;

    await store.update(c.id, {
      status: 'captured', consent: true, consent_fixed_text: CONSENT_FIXED, user_agent: str(req.headers['user-agent'], 300),
      ip: ip || null, ip_city: ipGeo?.city || null, ip_region: ipGeo?.region || null, ip_country: ipGeo?.country || null,
      ip_lat: ipGeo?.lat ?? null, ip_lng: ipGeo?.lng ?? null, ip_org: ipGeo?.org || null,
      gps_lat: gLat, gps_lng: gLng, gps_accuracy: gAcc, gps_address: gpsAddr ? gpsAddr.slice(0, 400) : null,
      captured_at: new Date().toISOString(),
      live_consent: liveConsent, live_consent_text: liveConsent ? CONSENT_LIVE : null,
    });
    res.json({ ok: true, status: 'captured', live: liveConsent });
  });

  // Atualização de localização em tempo real (enquanto a tela da pessoa está aberta e ela consentiu).
  app.post('/api/v/:token/live', async (req, res) => {
    const c = await check(req.params.token);
    if (isExpired(c)) { await store.update(c.id, { status: 'expired' }); throw bad('Este link expirou.'); }
    if (c.status !== 'captured') throw bad('Confirmação não concluída.');
    if (!c.live_consent) throw new HttpError(403, 'Compartilhamento em tempo real não autorizado.');
    const lat = geo.num(req.body?.gps?.lat), lng = geo.num(req.body?.gps?.lng), acc = geo.num(req.body?.gps?.accuracy);
    if (lat == null || lng == null) throw bad('Coordenadas inválidas.');
    await store.update(c.id, { live_lat: lat, live_lng: lng, live_accuracy: acc, live_updated_at: new Date().toISOString(), live_active: true });
    res.json({ ok: true });
  });

  // A pessoa parou de compartilhar (ou fechou a tela).
  app.post('/api/v/:token/live/stop', async (req, res) => {
    const c = await store.getByToken(req.params.token);
    if (c) await store.update(c.id, { live_active: false });
    res.json({ ok: true });
  });

  // ===================== Painel (exige login) =====================
  app.post('/api/checks', auth.requireAuth, async (req, res) => {
    const hours = Math.min(168, Math.max(1, int(req.body?.hours, 24)));
    const label = str(req.body?.label, 120) || null;
    const phone = str(req.body?.phone, 30) || null;
    const purpose = str(req.body?.purpose, 300) || null;
    const c = await store.create({
      token: store.randomToken(16), label, phone, purpose, status: 'pending',
      expires_at: new Date(Date.now() + hours * 3600000).toISOString(),
    });
    const url = `${siteUrl(req)}/v/${c.token}`;
    const msg = `Olá! ${purpose ? purpose + '\n\n' : ''}Para confirmarmos seus dados, abra o link abaixo e autorize a verificação da sua localização (leva alguns segundos):\n${url}\n\n${APP_NAME()}`;
    res.status(201).json({ ...view(c), url, message: msg, wa_link: waLink(phone, msg) });
  });

  app.get('/api/checks', auth.requireAuth, async (req, res) => {
    res.json((await store.list()).map(view));
  });

  app.get('/api/checks/:id', auth.requireAuth, async (req, res) => {
    const c = await store.getById(req.params.id);
    if (!c) throw notFound();
    const url = `${siteUrl(req)}/v/${c.token}`;
    const msg = `Olá! ${c.purpose ? c.purpose + '\n\n' : ''}Para confirmarmos seus dados, abra o link abaixo e autorize a verificação da sua localização:\n${url}\n\n${APP_NAME()}`;
    res.json({ ...view(c), url, message: msg, wa_link: waLink(c.phone, msg) });
  });

  app.delete('/api/checks/:id', auth.requireAuth, async (req, res) => {
    await store.remove(req.params.id);
    res.json({ ok: true });
  });

  // ===================== Páginas / estáticos =====================
  app.get('/v/:token', (req, res) => res.sendFile(path.join(pub, 'v.html')));
  app.use(express.static(pub));
  app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Erro interno' });
  });

  return app;
}

// Export padrão = instância pronta (requisito do runtime de função da Vercel),
// com createApp/waLink/siteUrl como propriedades para uso local e testes.
const app = createApp();
app.createApp = createApp;
app.waLink = waLink;
app.siteUrl = siteUrl;
module.exports = app;
