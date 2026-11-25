'use strict';
const express = require('express');
const DB = require('./db');
const F = require('./finance');
const M = require('./messaging');
const auth = require('./auth');
const geo = require('./geo');
const { runAutomations } = require('./scheduler');
const { createStorage, LIMITS } = require('./storage');
const backup = require('./backup');

const SECRET_KEYS = ['wa_cloud_token', 'wa_evolution_apikey', 'wa_zapi_token', 'wa_zapi_client_token'];
const MASK = '••••••••';
const METHODS = ['simple', 'price', 'interest_only'];
const FREQS = ['monthly', 'biweekly', 'weekly', 'daily'];
const OPEN_APP = ['pending', 'needs_changes'];

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const notFound = (what = 'Registro') => new HttpError(404, `${what} não encontrado`);
const forbidden = () => new HttpError(403, 'Apenas a conta central pode fazer isso');
const int = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.round(Number(v)) : d);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);

/**
 * Cria a aplicação. Na Vercel o banco é conectado na primeira requisição.
 * @param {object} opts { db: conexão pronta (testes), storage }
 */
function createApp(opts = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const storage = opts.storage || createStorage();
  let dbPromise = opts.db ? Promise.resolve(opts.db) : null;
  const getDb = () => (dbPromise ||= DB.connect().catch((e) => { dbPromise = null; throw e; }));
  let db; // preenchido pelo middleware abaixo

  // Páginas e arquivos do painel (na Vercel normalmente vêm da CDN; aqui é o reserva).
  app.use(express.static(require('node:path').join(__dirname, '..', 'public')));
  app.use('/api', async (req, res, next) => { try { db = await getDb(); next(); } catch (e) { next(e); } });
  app.use(express.json({ limit: '2mb' }));

  const baseUrl = (req) => (process.env.PUBLIC_URL ? null : `${req.protocol}://${req.get('host')}`);
  const today = async () => F.todayIn((await DB.getSettings(db)).timezone);

  // ===================== Escopo por conta =====================
  const isAdmin = (req) => req.user.role === 'admin';
  /** Conta em foco: afiliado = ele mesmo; central = conta escolhida no seletor (ou todas = null). */
  function scope(req) {
    if (!isAdmin(req)) return req.user.id;
    const n = parseInt(req.headers['x-account'] || req.query.account, 10);
    return n > 0 ? n : null;
  }
  function where(req, col, params) {
    const o = scope(req);
    if (o == null) return 'TRUE';
    params.push(o);
    return `${col}=$${params.length}`;
  }
  function assertAccess(req, ownerId) {
    if (!isAdmin(req) && ownerId !== req.user.id) throw notFound();
  }
  async function writeOwner(req, requested) {
    if (!isAdmin(req)) return req.user.id;
    const id = int(requested) || scope(req) || req.user.id;
    if (!(await db.one('SELECT 1 FROM users WHERE id=$1', [id]))) throw bad('Conta inválida');
    return id;
  }
  const adminOnly = (req) => { if (!isAdmin(req)) throw forbidden(); };

  async function clientFor(req, id) {
    const c = await db.one('SELECT * FROM clients WHERE id=$1', [int(id)]);
    if (!c) throw notFound('Cliente');
    assertAccess(req, c.owner_id);
    return c;
  }
  async function loanFor(req, id) {
    const l = await db.one('SELECT * FROM loans WHERE id=$1', [int(id)]);
    if (!l) throw notFound('Empréstimo');
    assertAccess(req, l.owner_id);
    return l;
  }
  async function installmentFor(req, id) {
    const i = await db.one('SELECT i.*, l.owner_id FROM installments i JOIN loans l ON l.id=i.loan_id WHERE i.id=$1', [int(id)]);
    if (!i) throw notFound('Parcela');
    assertAccess(req, i.owner_id);
    return i;
  }
  async function applicationFor(req, id) {
    const a = await db.one('SELECT * FROM applications WHERE id=$1', [int(id)]);
    if (!a) throw notFound('Cadastro');
    assertAccess(req, a.owner_id);
    return a;
  }
  const accountNames = async () => Object.fromEntries((await db.query('SELECT id, name FROM users')).map((u) => [u.id, u.name]));
  const logNote = (q, { ownerId, clientId = null, applicationId = null, loanId = null, installmentId = null, kind = 'note', body }) =>
    q.query("INSERT INTO messages(owner_id, client_id, application_id, loan_id, installment_id, direction, channel, kind, body, status) VALUES ($1,$2,$3,$4,$5,'note','crm',$6,$7,'logged')",
      [ownerId, clientId, applicationId, loanId, installmentId, kind, body]);

  // ===================== Webhook do WhatsApp (por conta) =====================
  app.get('/api/webhooks/whatsapp/:token', async (req, res) => {
    const owner = await db.one('SELECT id FROM users WHERE inbound_token=$1', [req.params.token]);
    if (!owner) return res.sendStatus(403);
    if (req.query['hub.mode'] === 'subscribe') return res.send(String(req.query['hub.challenge'] || ''));
    res.send('ok');
  });
  app.post('/api/webhooks/whatsapp/:token', async (req, res) => {
    const owner = await db.one('SELECT * FROM users WHERE inbound_token=$1 AND active', [req.params.token]);
    if (!owner) return res.sendStatus(403);
    for (const m of M.parseInbound(req.body)) {
      try { await M.handleInbound(db, owner, m, baseUrl(req)); } catch (e) { console.error('[webhook]', e); }
    }
    res.json({ ok: true });
  });

  // ===================== Cron da Vercel =====================
  app.get('/api/cron/automations', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.sendStatus(401);
    res.json(await runAutomations(db, { force: true }));
  });

  app.get('/api/cron/backup', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.sendStatus(401);
    const r = await backup.runBackup(db, { storage, dir: opts.backupDir });
    res.status(r.ok ? 200 : 500).json(r);
  });

  // ===================== Cadastro público (link enviado ao cliente) =====================
  const pub = express.Router();
  app.use('/api/public', pub);

  async function publicApplication(token) {
    const a = await db.one('SELECT * FROM applications WHERE token=$1', [String(token)]);
    if (!a) throw notFound('Cadastro');
    return a;
  }
  async function publicView(a) {
    const s = await DB.accountSettings(db, a.owner_id);
    const types = await db.query('SELECT id, name, kind, instructions, required FROM document_types WHERE active ORDER BY sort, id');
    const files = await db.query('SELECT id, document_type_id, label, content_type, size, status, reject_reason, created_at FROM application_files WHERE application_id=$1 ORDER BY id', [a.id]);
    return {
      business_name: s.business_name, status: a.status, editable: OPEN_APP.includes(a.status), upload_mode: storage.mode, upload_prefix: `apps/${a.id}/`,
      data: {
        name: a.name, phone: a.phone, document: a.document, birth_date: a.birth_date, email: a.email, address: a.address,
        occupation: a.occupation, income_cents: a.income_cents, requested_cents: a.requested_cents, requested_installments: a.requested_installments, client_notes: a.client_notes,
      },
      review_notes: a.status === 'needs_changes' ? a.review_notes : null,
      document_types: types, files,
      limits: Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, { types: v.types, max: v.max }])),
    };
  }
  const assertEditable = (a) => { if (!OPEN_APP.includes(a.status)) throw bad(a.status === 'submitted' ? 'Seu cadastro já foi enviado e está em análise' : 'Este cadastro não pode mais ser alterado'); };

  pub.get('/signup/:slug', async (req, res) => {
    const u = await db.one('SELECT id FROM users WHERE signup_slug=$1 AND active', [req.params.slug]);
    if (!u) throw notFound('Link');
    res.json({ business_name: (await DB.accountSettings(db, u.id)).business_name });
  });
  pub.post('/signup/:slug', async (req, res) => {
    const u = await db.one('SELECT id FROM users WHERE signup_slug=$1 AND active', [req.params.slug]);
    if (!u) throw notFound('Link');
    const name = str(req.body?.name, 120);
    const phone = str(req.body?.phone, 30);
    if (!name || phone.replace(/\D/g, '').length < 10) throw bad('Informe seu nome e WhatsApp com DDD');
    const a = await db.one("INSERT INTO applications(owner_id, token, source, name, phone) VALUES ($1,$2,'link',$3,$4) RETURNING token", [u.id, DB.randomToken(16), name, phone]);
    res.status(201).json({ token: a.token });
  });

  pub.get('/apply/:token', async (req, res) => res.json(await publicView(await publicApplication(req.params.token))));

  pub.put('/apply/:token', async (req, res) => {
    const a = await publicApplication(req.params.token);
    assertEditable(a);
    const b = req.body || {};
    await db.query(`UPDATE applications SET name=$1, phone=$2, document=$3, birth_date=$4, email=$5, address=$6, occupation=$7,
      income_cents=$8, requested_cents=$9, requested_installments=$10, client_notes=$11, updated_at=now() WHERE id=$12`,
    [str(b.name, 120), str(b.phone, 30), str(b.document, 30), isDate(b.birth_date) ? b.birth_date : null, str(b.email, 120), str(b.address, 300),
      str(b.occupation, 120), Math.max(0, int(b.income_cents)), Math.max(0, int(b.requested_cents)), Math.max(0, int(b.requested_installments)), str(b.client_notes, 1000), a.id]);
    res.json(await publicView(await publicApplication(req.params.token)));
  });

  async function docTypeFor(id) {
    const t = await db.one('SELECT * FROM document_types WHERE id=$1 AND active', [int(id)]);
    if (!t) throw bad('Tipo de documento inválido');
    return t;
  }
  const extOf = (name) => (String(name || '').match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'bin').toLowerCase();

  // Upload direto do navegador para o Vercel Blob (fotos/vídeos grandes não passam pelo servidor).
  pub.post('/apply/:token/upload', async (req, res) => {
    if (storage.mode !== 'blob') throw bad('Upload direto indisponível');
    const a = await publicApplication(req.params.token);
    assertEditable(a);
    const { handleUpload } = require('@vercel/blob/client');
    try {
      const json = await handleUpload({
        body: req.body,
        request: req,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          const { type } = JSON.parse(clientPayload || '{}');
          const t = await docTypeFor(type);
          if (!pathname.startsWith(`apps/${a.id}/`)) throw new Error('Caminho inválido');
          const lim = LIMITS[t.kind] || LIMITS.file;
          return { allowedContentTypes: lim.types, maximumSizeInBytes: lim.max, addRandomSuffix: true };
        },
      });
      res.json(json);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Upload em modo local (desenvolvimento): corpo binário.
  pub.put('/apply/:token/upload-local', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
    if (storage.mode !== 'local') throw bad('Indisponível');
    const a = await publicApplication(req.params.token);
    assertEditable(a);
    const t = await docTypeFor(req.query.type);
    const ct = String(req.headers['content-type'] || '').split(';')[0];
    const lim = LIMITS[t.kind] || LIMITS.file;
    if (!lim.types.includes(ct)) throw bad('Formato de arquivo não aceito para este documento');
    if (!req.body?.length || req.body.length > lim.max) throw bad('Arquivo vazio ou muito grande');
    const pathname = `apps/${a.id}/${DB.randomToken(8)}.${extOf(req.query.name)}`;
    await storage.put(pathname, req.body);
    res.json(await registerFile(a, t, { pathname, contentType: ct, size: req.body.length }));
  });

  async function registerFile(a, t, { pathname, contentType, size }) {
    return db.one(`INSERT INTO application_files(application_id, document_type_id, label, pathname, content_type, size)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, document_type_id, label, content_type, size, status, created_at`, [a.id, t.id, t.name, pathname, contentType, size]);
  }

  // Após o upload direto, o navegador registra o arquivo.
  pub.post('/apply/:token/files', async (req, res) => {
    const a = await publicApplication(req.params.token);
    assertEditable(a);
    const t = await docTypeFor(req.body?.type);
    const pathname = String(req.body?.pathname || '');
    if (!pathname.startsWith(`apps/${a.id}/`)) throw bad('Arquivo inválido');
    const meta = await storage.head(pathname);
    if (!meta) throw bad('Arquivo não encontrado no armazenamento');
    res.status(201).json(await registerFile(a, t, { pathname, contentType: meta.contentType || req.body.content_type, size: meta.size || 0 }));
  });

  pub.delete('/apply/:token/files/:id', async (req, res) => {
    const a = await publicApplication(req.params.token);
    assertEditable(a);
    const f = await db.one('SELECT * FROM application_files WHERE id=$1 AND application_id=$2', [int(req.params.id), a.id]);
    if (!f) throw notFound('Arquivo');
    if (f.status === 'approved') throw bad('Documento já aprovado não pode ser removido');
    await db.query('DELETE FROM application_files WHERE id=$1', [f.id]);
    await storage.remove(f.pathname);
    res.json({ ok: true });
  });

  pub.post('/apply/:token/submit', async (req, res) => {
    const a = await publicApplication(req.params.token);
    assertEditable(a);
    const missing = [];
    if (!a.name) missing.push('Nome completo');
    if (!a.document) missing.push('CPF');
    if (!a.phone) missing.push('WhatsApp');
    const types = await db.query('SELECT * FROM document_types WHERE active AND required ORDER BY sort, id');
    const files = await db.query("SELECT document_type_id FROM application_files WHERE application_id=$1 AND status<>'rejected'", [a.id]);
    for (const t of types) if (!files.some((f) => f.document_type_id === t.id)) missing.push(t.name);
    if (missing.length) throw bad('Falta enviar: ' + missing.join(', '));
    await db.tx(async (q) => {
      await q.query("UPDATE applications SET status='submitted', submitted_at=now(), updated_at=now() WHERE id=$1", [a.id]);
      await logNote(q, { ownerId: a.owner_id, applicationId: a.id, body: `Cadastro ${a.status === 'needs_changes' ? 'reenviado' : 'enviado'} para análise por ${a.name}.` });
    });
    res.json(await publicView(await publicApplication(req.params.token)));
  });

  // ===================== Verificação de localização (consentida) =====================
  // O operador gera um link e envia ao cliente pelo WhatsApp. O cliente abre, vê o
  // aviso de privacidade e autoriza; só então o IP e o GPS do navegador são registrados.
  const CONSENT_TEXT = 'Autorizo o registro da minha localização (aproximada por IP e, se eu permitir no navegador, precisa por GPS) para confirmação de dados neste atendimento.';

  async function locationCheck(token) {
    const l = await db.one('SELECT * FROM location_checks WHERE token=$1', [String(token)]);
    if (!l) throw notFound('Link de verificação');
    return l;
  }
  const isExpired = (l) => new Date(l.expires_at).getTime() < Date.now();
  function locationView(l) {
    const expired = l.status === 'pending' && isExpired(l);
    return {
      id: l.id, status: expired ? 'expired' : l.status, purpose: l.purpose, expected_address: l.expected_address, consent: l.consent,
      ip: l.ip, ip_city: l.ip_city, ip_region: l.ip_region, ip_country: l.ip_country, ip_org: l.ip_org,
      ip_place: [l.ip_city, l.ip_region, l.ip_country].filter(Boolean).join(', ') || null,
      gps_lat: l.gps_lat, gps_lng: l.gps_lng, gps_accuracy: l.gps_accuracy, gps_address: l.gps_address,
      maps_url: (l.gps_lat != null && l.gps_lng != null) ? `https://www.google.com/maps?q=${l.gps_lat},${l.gps_lng}` : null,
      captured_at: l.captured_at, expires_at: l.expires_at, created_at: l.created_at,
    };
  }

  pub.get('/local/:token', async (req, res) => {
    const l = await locationCheck(req.params.token);
    const s = await DB.accountSettings(db, l.owner_id);
    const expired = l.status === 'pending' && isExpired(l);
    res.json({
      business_name: s.business_name,
      status: expired ? 'expired' : l.status,
      done: l.status !== 'pending' || expired,
      purpose: l.purpose || null,
      consent_text: CONSENT_TEXT,
    });
  });

  pub.post('/local/:token', async (req, res) => {
    const l = await locationCheck(req.params.token);
    if (l.status !== 'pending') throw bad('Este link já foi utilizado.');
    if (isExpired(l)) { await db.query("UPDATE location_checks SET status='expired' WHERE id=$1", [l.id]); throw bad('Este link expirou. Peça um novo ao atendente.'); }

    const b = req.body || {};
    if (!b.consent) {
      await db.query("UPDATE location_checks SET status='denied', consent=FALSE, user_agent=$2, captured_at=now() WHERE id=$1", [l.id, str(req.headers['user-agent'], 300)]);
      await logNote(db, { ownerId: l.owner_id, clientId: l.client_id, kind: 'location', body: `❌ O cliente abriu o link de verificação mas não autorizou o registro da localização.` });
      return res.json({ ok: true, status: 'denied' });
    }

    const ip = geo.ipFromReq(req);
    const ipGeo = await geo.lookupIp(ip).catch(() => null);
    const gLat = geo.num(b.gps?.lat);
    const gLng = geo.num(b.gps?.lng);
    const gAcc = geo.num(b.gps?.accuracy);
    const gpsAddr = (gLat != null && gLng != null) ? await geo.reverseGeocode(gLat, gLng).catch(() => null) : null;

    await db.query(`UPDATE location_checks SET status='captured', consent=TRUE, consent_text=$2, user_agent=$3,
      ip=$4, ip_city=$5, ip_region=$6, ip_country=$7, ip_lat=$8, ip_lng=$9, ip_org=$10,
      gps_lat=$11, gps_lng=$12, gps_accuracy=$13, gps_address=$14, captured_at=now() WHERE id=$1`,
    [l.id, CONSENT_TEXT, str(req.headers['user-agent'], 300),
      ip || null, ipGeo?.city || null, ipGeo?.region || null, ipGeo?.country || null, ipGeo?.lat ?? null, ipGeo?.lng ?? null, ipGeo?.org || null,
      gLat, gLng, gAcc, gpsAddr ? gpsAddr.slice(0, 400) : null]);

    const ipLine = ipGeo ? `${[ipGeo.city, ipGeo.region, ipGeo.country].filter(Boolean).join(', ')} (por IP${ip ? ' ' + ip : ''})` : `IP ${ip || 'desconhecido'} (sem geolocalização)`;
    const gpsLine = (gLat != null && gLng != null)
      ? `GPS: ${gLat.toFixed(5)}, ${gLng.toFixed(5)}${gAcc != null ? ` (±${Math.round(gAcc)} m)` : ''}${gpsAddr ? ` — ${gpsAddr}` : ''}\nMapa: https://www.google.com/maps?q=${gLat},${gLng}`
      : 'GPS: o cliente autorizou, mas o navegador não forneceu a localização precisa.';
    await logNote(db, { ownerId: l.owner_id, clientId: l.client_id, kind: 'location', body: `📍 Localização confirmada pelo cliente (com consentimento).\n${ipLine}\n${gpsLine}` });

    res.json({ ok: true, status: 'captured' });
  });

  // ===================== Área logada =====================
  auth.routes(app, { query: (...a) => db.query(...a), one: (...a) => db.one(...a), val: (...a) => db.val(...a) });
  const api = express.Router();
  api.use((req, res, next) => auth.requireAuth(db)(req, res, next));
  app.use('/api', api);

  api.post('/auth/password', async (req, res) => {
    const { current, password } = req.body || {};
    if (!auth.verifyPassword(current || '', req.user.password_hash)) throw bad('Senha atual incorreta');
    if (!password || String(password).length < 6) throw bad('A nova senha deve ter pelo menos 6 caracteres');
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [auth.hashPassword(password), req.user.id]);
    res.json({ ok: true });
  });

  api.get('/me', async (req, res) => {
    const accounts = isAdmin(req) ? await db.query('SELECT id, name, role, active FROM users ORDER BY role, name') : [];
    res.json({ user: auth.publicUser(req.user), accounts, system_name: (await DB.getSettings(db)).system_name });
  });

  // ---------- Contas (central + afiliados) ----------
  api.get('/accounts', async (req, res) => {
    adminOnly(req);
    const ref = await today();
    const users = await db.query('SELECT * FROM users ORDER BY role, name');
    const out = [];
    for (const u of users) {
      const open = await openInstallments(ref, u.id);
      const overdue = open.filter((i) => i.situation === 'overdue');
      out.push({
        ...auth.publicUser(u),
        clients: await db.val('SELECT COUNT(*)::int FROM clients WHERE owner_id=$1 AND NOT archived', [u.id]),
        active_loans: await db.val("SELECT COUNT(*)::int FROM loans WHERE owner_id=$1 AND status='active'", [u.id]),
        lent_cents: await db.val("SELECT COALESCE(SUM(principal_cents),0)::bigint FROM loans WHERE owner_id=$1 AND status<>'canceled'", [u.id]),
        receivable_cents: open.reduce((s, i) => s + i.remaining_cents, 0),
        overdue_cents: overdue.reduce((s, i) => s + i.remaining_cents, 0),
        received_cents: await db.val('SELECT COALESCE(SUM(p.amount_cents),0)::bigint FROM payments p JOIN loans l ON l.id=p.loan_id WHERE l.owner_id=$1', [u.id]),
        pending_applications: await db.val("SELECT COUNT(*)::int FROM applications WHERE owner_id=$1 AND status='submitted'", [u.id]),
        wa_provider: { ...DB.DEFAULT_ACCOUNT_SETTINGS, ...(u.settings || {}) }.wa_provider,
      });
    }
    res.json(out);
  });

  api.post('/accounts', async (req, res) => {
    adminOnly(req);
    // Administradores (central, suporte) têm acesso total; afiliados só aos próprios dados.
    const u = await auth.createUser(db, { ...req.body, role: req.body?.role === 'admin' ? 'admin' : 'affiliate' });
    res.status(201).json(auth.publicUser(u));
  });

  api.put('/accounts/:id', async (req, res) => {
    adminOnly(req);
    const u = await db.one('SELECT * FROM users WHERE id=$1', [int(req.params.id)]);
    if (!u) throw notFound('Conta');
    const b = req.body || {};
    const email = b.email != null ? str(b.email, 120).toLowerCase() : u.email;
    if (email !== u.email && await db.one('SELECT 1 FROM users WHERE email=$1 AND id<>$2', [email, u.id])) throw bad('E-mail já usado por outra conta');
    const self = u.id === req.user.id;
    const active = self ? true : (b.active != null ? !!b.active : u.active);
    const role = self ? u.role : (['admin', 'affiliate'].includes(b.role) ? b.role : u.role);
    // Nunca deixar o sistema sem nenhum administrador ativo.
    if (u.role === 'admin' && (role !== 'admin' || !active)) {
      const others = await db.val("SELECT COUNT(*)::int FROM users WHERE role='admin' AND active AND id<>$1", [u.id]);
      if (!others) throw bad('É preciso manter pelo menos um administrador ativo');
    }
    await db.query('UPDATE users SET name=$1, email=$2, phone=$3, active=$4, role=$5 WHERE id=$6', [str(b.name ?? u.name, 120) || u.name, email, str(b.phone ?? u.phone, 30), active, role, u.id]);
    if (b.password) {
      if (String(b.password).length < 6) throw bad('A senha deve ter pelo menos 6 caracteres');
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [auth.hashPassword(b.password), u.id]);
      await db.query('DELETE FROM sessions WHERE user_id=$1 AND user_id<>$2', [u.id, req.user.id]);
    }
    if (!active) await db.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
    res.json(auth.publicUser(await db.one('SELECT * FROM users WHERE id=$1', [u.id])));
  });

  // ---------- Configurações da conta (PIX, nome, WhatsApp) ----------
  function targetAccount(req) {
    if (!isAdmin(req)) return req.user.id;
    return int(req.query.account) || req.user.id;
  }
  api.get('/account-settings', async (req, res) => {
    const id = targetAccount(req);
    const u = await db.one('SELECT * FROM users WHERE id=$1', [id]);
    if (!u) throw notFound('Conta');
    const s = { ...DB.DEFAULT_ACCOUNT_SETTINGS, ...(u.settings || {}) };
    for (const k of SECRET_KEYS) if (s[k]) s[k] = MASK;
    const base = M.siteUrl(baseUrl(req));
    res.json({
      account: auth.publicUser(u), settings: s,
      webhook_url: `${base}/api/webhooks/whatsapp/${u.inbound_token}`,
      signup_url: `${base}/cadastro.html?c=${u.signup_slug}`,
    });
  });
  api.put('/account-settings', async (req, res) => {
    const id = targetAccount(req);
    const u = await db.one('SELECT * FROM users WHERE id=$1', [id]);
    if (!u) throw notFound('Conta');
    const next = { ...DB.DEFAULT_ACCOUNT_SETTINGS, ...(u.settings || {}) };
    for (const k of Object.keys(DB.DEFAULT_ACCOUNT_SETTINGS)) {
      if (!(k in (req.body || {}))) continue;
      if (SECRET_KEYS.includes(k) && req.body[k] === MASK) continue;
      next[k] = str(req.body[k], 500);
    }
    await db.query('UPDATE users SET settings=$1 WHERE id=$2', [JSON.stringify(next), id]);
    res.json({ ok: true });
  });

  api.get('/whatsapp/status', async (req, res) => {
    const s = await DB.accountSettings(db, targetAccount(req));
    try { res.json(await M.connectionStatus(s)); } catch (e) { res.json({ provider: s.wa_provider, connected: false, automatic: true, error: e.message }); }
  });
  api.post('/whatsapp/qr', async (req, res) => {
    try { res.json(await M.connectionQR(await DB.accountSettings(db, targetAccount(req)))); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  api.post('/whatsapp/test', async (req, res) => {
    const s = await DB.accountSettings(db, targetAccount(req));
    try { res.json({ ok: true, ...(await M.sendWhatsApp(s, String(req.body?.phone || ''), `Teste de envio — ${s.business_name}`)) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- Configurações gerais (somente central) ----------
  api.get('/settings', async (req, res) => res.json(await DB.getSettings(db)));
  api.put('/settings', async (req, res) => {
    adminOnly(req);
    const b = {};
    for (const k of Object.keys(DB.DEFAULT_SETTINGS)) if (k in (req.body || {})) b[k] = str(req.body[k], 4000);
    await DB.setSettings(db, b);
    res.json({ ok: true });
  });

  // ---------- Leituras compartilhadas ----------
  async function loanWithState(loan, ref) {
    ref = ref || await today();
    const insts = (await db.query('SELECT * FROM installments WHERE loan_id=$1 ORDER BY number', [loan.id])).map((i) => F.installmentState(i, loan, ref));
    const open = insts.filter((i) => i.status === 'open');
    return {
      ...loan,
      installments: insts,
      paid_cents: insts.reduce((s, i) => s + i.paid_cents, 0),
      balance_cents: open.reduce((s, i) => s + i.remaining_cents, 0),
      overdue_cents: open.filter((i) => i.situation === 'overdue').reduce((s, i) => s + i.remaining_cents, 0),
      overdue_count: open.filter((i) => i.situation === 'overdue').length,
      paid_count: insts.filter((i) => i.status === 'paid').length,
      next_due: open[0]?.due_date || null,
      max_days_late: open.reduce((m, i) => Math.max(m, i.days_late), 0),
    };
  }
  const summarize = (l) => { const { installments, ...rest } = l; void installments; return rest; };

  async function openInstallments(ref, ownerId) {
    const params = [];
    let f = '';
    if (ownerId) { params.push(ownerId); f = 'AND l.owner_id=$1'; }
    const rows = await db.query(`
      SELECT i.*, l.late_fee_percent, l.late_interest_daily, l.installments_count, l.client_id, l.owner_id,
             c.name AS client_name, c.phone AS client_phone
      FROM installments i JOIN loans l ON l.id=i.loan_id JOIN clients c ON c.id=l.client_id
      WHERE i.status='open' AND l.status='active' ${f} ORDER BY i.due_date`, params);
    return rows.map((r) => F.installmentState(r, r, ref));
  }

  // ---------- Painel ----------
  api.get('/dashboard', async (req, res) => {
    const ref = await today();
    const owner = scope(req);
    const open = await openInstallments(ref, owner);
    const overdue = open.filter((i) => i.situation === 'overdue');
    const in7 = F.addDays(ref, 7);
    const upcoming = open.filter((i) => i.due_date >= ref && i.due_date <= in7);
    const monthStart = ref.slice(0, 8) + '01';
    const p = [];
    const wl = where(req, 'l.owner_id', p);
    const sumPay = async (from, to) => db.val(`SELECT COALESCE(SUM(p.amount_cents),0)::bigint FROM payments p JOIN loans l ON l.id=p.loan_id WHERE ${wl} AND p.paid_at BETWEEN $${p.length + 1} AND $${p.length + 2}`, [...p, from, to]);
    const receivedTotal = await db.val(`SELECT COALESCE(SUM(p.amount_cents),0)::bigint FROM payments p JOIN loans l ON l.id=p.loan_id WHERE ${wl}`, p);
    const lentTotal = await db.val(`SELECT COALESCE(SUM(principal_cents),0)::bigint FROM loans l WHERE ${wl} AND status<>'canceled'`, p);
    const profit = await db.val(`SELECT COALESCE(SUM(LEAST(i.paid_cents, i.interest_cents + i.penalty_cents)),0)::bigint FROM installments i JOIN loans l ON l.id=i.loan_id WHERE ${wl} AND l.status<>'canceled'`, p);
    const principalOut = open.reduce((s, i) => s + Math.max(0, i.principal_cents - Math.max(0, i.paid_cents - i.interest_cents - i.current_penalty_cents)), 0);
    const receivable = open.reduce((s, i) => s + i.remaining_cents, 0);
    const overdueCents = overdue.reduce((s, i) => s + i.remaining_cents, 0);
    const pm = [];
    const wm = where(req, 'owner_id', pm);
    const months = [];
    for (let k = 5; k >= 0; k--) {
      const d = F.addMonths(monthStart, -k);
      const end = F.addDays(F.addMonths(d, 1), -1);
      months.push({
        month: d.slice(0, 7),
        received: await sumPay(d, end),
        lent: await db.val(`SELECT COALESCE(SUM(principal_cents),0)::bigint FROM loans l WHERE ${wl} AND status<>'canceled' AND start_date BETWEEN $${p.length + 1} AND $${p.length + 2}`, [...p, d, end]),
      });
    }
    const names = await accountNames();
    const tag = (i) => ({ ...i, account_name: names[i.owner_id] });
    res.json({
      today: ref,
      totals: {
        lent_total: lentTotal, received_total: receivedTotal, received_month: await sumPay(monthStart, ref),
        receivable, overdue: overdueCents, principal_out: principalOut, profit_realized: profit,
        expected_profit: receivable + receivedTotal - lentTotal,
        active_loans: await db.val(`SELECT COUNT(*)::int FROM loans l WHERE ${wl} AND status='active'`, p),
        clients: await db.val(`SELECT COUNT(*)::int FROM clients WHERE ${wm} AND NOT archived`, pm),
        overdue_clients: new Set(overdue.map((i) => i.client_id)).size,
        delinquency_rate: receivable ? overdueCents / receivable : 0,
        pending_manual: await db.val(`SELECT COUNT(*)::int FROM messages WHERE ${wm} AND status='pending_manual'`, pm),
        failed_messages: await db.val(`SELECT COUNT(*)::int FROM messages WHERE ${wm} AND status='failed' AND created_at >= now() - interval '7 days'`, pm),
        unread_inbound: await db.val(`SELECT COUNT(*)::int FROM messages WHERE ${wm} AND direction='in' AND status='received'`, pm),
        applications_review: await db.val(`SELECT COUNT(*)::int FROM applications WHERE ${wm} AND status='submitted'`, pm),
        applications_open: await db.val(`SELECT COUNT(*)::int FROM applications WHERE ${wm} AND status IN ('pending','needs_changes')`, pm),
        backup: isAdmin(req) ? await backup.lastStatus(db) : undefined,
      },
      overdue: overdue.slice(0, 20).map(tag),
      upcoming: upcoming.slice(0, 20).map(tag),
      months,
    });
  });

  // ---------- Clientes ----------
  function clientPayload(b) {
    const name = str(b.name, 120);
    if (!name) throw bad('Informe o nome do cliente');
    return {
      name, phone: str(b.phone, 30), document: str(b.document, 30), email: str(b.email, 120), address: str(b.address, 300),
      birth_date: isDate(b.birth_date) ? b.birth_date : null, occupation: str(b.occupation, 120), income_cents: Math.max(0, int(b.income_cents)),
      notes: str(b.notes, 4000), tags: str(b.tags, 300), score: Math.min(5, Math.max(1, int(b.score, 3))),
      whatsapp_opt_in: !(b.whatsapp_opt_in === false || b.whatsapp_opt_in === 0 || b.whatsapp_opt_in === 'false'),
    };
  }
  const CLIENT_COLS = ['name', 'phone', 'document', 'email', 'address', 'birth_date', 'occupation', 'income_cents', 'notes', 'tags', 'score', 'whatsapp_opt_in'];
  async function insertClient(q, ownerId, c, applicationId = null) {
    const cols = [...CLIENT_COLS, 'owner_id', 'application_id'];
    const vals = [...CLIENT_COLS.map((k) => c[k]), ownerId, applicationId];
    return (await q.query(`INSERT INTO clients(${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals))[0];
  }

  api.get('/clients', async (req, res) => {
    const p = [];
    const w = where(req, 'owner_id', p);
    const q = `%${str(req.query.q, 100)}%`;
    p.push(req.query.archived === '1', q);
    const rows = await db.query(`SELECT * FROM clients WHERE ${w} AND archived=$${p.length - 1}
      AND (name ILIKE $${p.length} OR phone ILIKE $${p.length} OR document ILIKE $${p.length} OR tags ILIKE $${p.length}) ORDER BY name`, p);
    const open = await openInstallments(await today(), scope(req));
    const by = new Map();
    for (const i of open) {
      const c = by.get(i.client_id) || { balance: 0, overdue: 0, max_late: 0 };
      c.balance += i.remaining_cents;
      if (i.situation === 'overdue') { c.overdue += i.remaining_cents; c.max_late = Math.max(c.max_late, i.days_late); }
      by.set(i.client_id, c);
    }
    const names = await accountNames();
    res.json(rows.map((c) => {
      const s = by.get(c.id) || { balance: 0, overdue: 0, max_late: 0 };
      return { ...c, account_name: names[c.owner_id], balance_cents: s.balance, overdue_cents: s.overdue, max_days_late: s.max_late };
    }));
  });

  api.post('/clients', async (req, res) => {
    const ownerId = await writeOwner(req, req.body?.owner_id);
    const c = await insertClient(db, ownerId, clientPayload(req.body || {}));
    res.status(201).json(c);
  });

  api.get('/clients/:id', async (req, res) => {
    const c = await clientFor(req, req.params.id);
    const ref = await today();
    const loans = [];
    for (const l of await db.query('SELECT * FROM loans WHERE client_id=$1 ORDER BY start_date DESC, id DESC', [c.id])) loans.push(summarize(await loanWithState(l, ref)));
    const messages = await db.query('SELECT * FROM messages WHERE client_id=$1 OR (application_id IS NOT NULL AND application_id=$2) ORDER BY created_at DESC, id DESC LIMIT 300', [c.id, c.application_id || 0]);
    const payments = await db.query(`SELECT p.*, i.number FROM payments p JOIN installments i ON i.id=p.installment_id JOIN loans l ON l.id=p.loan_id
      WHERE l.client_id=$1 ORDER BY p.paid_at DESC, p.id DESC LIMIT 100`, [c.id]);
    const files = c.application_id ? await db.query('SELECT id, label, content_type, size, status, created_at FROM application_files WHERE application_id=$1 ORDER BY id', [c.application_id]) : [];
    await db.query("UPDATE messages SET status='read' WHERE client_id=$1 AND direction='in' AND status='received'", [c.id]);
    const s = await DB.accountSettings(db, c.owner_id);
    const locationChecks = (await db.query('SELECT * FROM location_checks WHERE client_id=$1 ORDER BY created_at DESC, id DESC LIMIT 20', [c.id])).map(locationView);
    res.json({ ...c, account_name: (await accountNames())[c.owner_id], wa_link: c.phone ? M.waLink(c.phone, '', s.default_country_code) : null, loans, messages, payments, files, location_checks: locationChecks });
  });

  api.put('/clients/:id', async (req, res) => {
    const old = await clientFor(req, req.params.id);
    const c = clientPayload({ ...old, ...req.body });
    const archived = req.body?.archived != null ? !!req.body.archived : old.archived;
    const ownerId = isAdmin(req) && req.body?.owner_id ? await writeOwner(req, req.body.owner_id) : old.owner_id;
    const sets = CLIENT_COLS.map((k, i) => `${k}=$${i + 1}`).join(', ');
    await db.query(`UPDATE clients SET ${sets}, archived=$${CLIENT_COLS.length + 1}, owner_id=$${CLIENT_COLS.length + 2} WHERE id=$${CLIENT_COLS.length + 3}`,
      [...CLIENT_COLS.map((k) => c[k]), archived, ownerId, old.id]);
    if (ownerId !== old.owner_id) await db.query('UPDATE loans SET owner_id=$1 WHERE client_id=$2', [ownerId, old.id]);
    res.json(await db.one('SELECT * FROM clients WHERE id=$1', [old.id]));
  });

  api.delete('/clients/:id', async (req, res) => {
    const c = await clientFor(req, req.params.id);
    if (await db.one('SELECT 1 FROM loans WHERE client_id=$1', [c.id])) throw bad('Cliente possui empréstimos. Arquive-o em vez de excluir.');
    await db.query('DELETE FROM clients WHERE id=$1', [c.id]);
    res.json({ ok: true });
  });

  api.post('/clients/:id/notes', async (req, res) => {
    const c = await clientFor(req, req.params.id);
    const body = str(req.body?.body, 4000);
    if (!body) throw bad('Escreva a anotação');
    await logNote(db, { ownerId: c.owner_id, clientId: c.id, loanId: req.body.loan_id ? int(req.body.loan_id) : null, body });
    res.status(201).json({ ok: true });
  });

  // Gera o link de verificação e o ENVIA pela conexão de WhatsApp da conta
  // (Cloud API / Evolution / Z-API). No modo manual, devolve o link pronto para enviar.
  api.post('/clients/:id/location-check', async (req, res) => {
    const c = await clientFor(req, req.params.id);
    const hours = Math.min(168, Math.max(1, int(req.body?.hours, 24)));
    const purpose = str(req.body?.purpose, 300) || null;
    const send = req.body?.send !== false; // por padrão, dispara pelo WhatsApp
    const s = await DB.accountSettings(db, c.owner_id);
    const l = await db.one(`INSERT INTO location_checks(owner_id, client_id, token, purpose, expected_address, expires_at)
      VALUES ($1,$2,$3,$4,$5, now() + ($6::int * interval '1 hour')) RETURNING *`,
    [c.owner_id, c.id, DB.randomToken(16), purpose, c.address || null, hours]);
    const url = `${M.siteUrl(baseUrl(req))}/local.html?t=${l.token}`;
    const first = String(c.name || '').trim().split(/\s+/)[0] || '';
    const body = `Olá ${first}! ${purpose ? purpose + '\n\n' : ''}Para confirmarmos seus dados, abra o link abaixo e autorize a verificação da sua localização (leva alguns segundos):\n${url}\n\n${s.business_name}`;
    let message = null;
    if (send) {
      // dispatch registra no histórico e envia pelo provedor conectado (ou deixa pronto para envio manual)
      message = await withLink(await M.dispatch(db, { ownerId: c.owner_id, client: c, channel: 'whatsapp', kind: 'location_link', body, settings: s }), c.phone);
    } else {
      await logNote(db, { ownerId: c.owner_id, clientId: c.id, kind: 'location', body: `🔗 Link de verificação de localização gerado (válido por ${hours}h).` });
    }
    res.status(201).json({
      ...locationView(l), url, body,
      sent: send ? (message?.status || 'failed') : 'not_sent',
      send_error: message?.error || null,
      wa_link: message?.wa_link || (c.phone ? M.waLink(c.phone, body, s.default_country_code) : null),
    });
  });

  api.get('/clients/:id/location-checks', async (req, res) => {
    const c = await clientFor(req, req.params.id);
    const rows = await db.query('SELECT * FROM location_checks WHERE client_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50', [c.id]);
    res.json(rows.map(locationView));
  });

  async function withLink(msg, phone) {
    if (!msg) return msg;
    const s = await DB.accountSettings(db, msg.owner_id);
    const to = phone || msg.phone;
    return { ...msg, wa_link: msg.channel === 'whatsapp' && to ? M.waLink(to, msg.body, s.default_country_code) : null };
  }

  api.post('/clients/:id/messages', async (req, res) => {
    const c = await clientFor(req, req.params.id);
    const b = req.body || {};
    const installment = b.installment_id ? await installmentFor(req, b.installment_id) : null;
    const loan = installment ? await loanFor(req, installment.loan_id) : b.loan_id ? await loanFor(req, b.loan_id) : null;
    const s = await DB.accountSettings(db, c.owner_id);
    let body = String(b.body || '');
    if (!body && b.template_id) body = (await db.one('SELECT body FROM templates WHERE id=$1', [int(b.template_id)]))?.body || '';
    body = M.render(body, await M.buildContext(db, { settings: s, client: c, loan, installment })).trim();
    if (!body) throw bad('Mensagem vazia');
    const msg = await M.dispatch(db, { ownerId: c.owner_id, client: c, loanId: loan?.id || null, installmentId: installment?.id || null, channel: b.channel === 'crm' ? 'crm' : 'whatsapp', kind: 'manual', body, settings: s });
    res.status(201).json(await withLink(msg, c.phone));
  });

  api.post('/preview-message', async (req, res) => {
    const b = req.body || {};
    const c = b.client_id ? await clientFor(req, b.client_id) : { name: 'Cliente Exemplo', phone: '' };
    const installment = b.installment_id ? await installmentFor(req, b.installment_id) : null;
    const loan = installment ? await db.one('SELECT * FROM loans WHERE id=$1', [installment.loan_id]) : null;
    const s = await DB.accountSettings(db, c.owner_id || scope(req) || req.user.id);
    res.json({ body: M.render(String(b.body || ''), await M.buildContext(db, { settings: s, client: c, loan, installment, extra: { link: `${M.siteUrl(baseUrl(req))}/cadastro.html?t=…`, pendencias: '• (itens recusados)' } })) });
  });

  // ---------- Empréstimos ----------
  async function loanInput(b) {
    const principal = int(b.principal_cents);
    const rate = Number(b.interest_rate);
    const method = METHODS.includes(b.method) ? b.method : null;
    const frequency = FREQS.includes(b.frequency) ? b.frequency : null;
    const count = int(b.installments_count);
    if (!(principal > 0)) throw bad('Informe o valor emprestado');
    if (!(rate >= 0 && rate < 1000)) throw bad('Taxa de juros inválida');
    if (!method) throw bad('Método de cálculo inválido');
    if (!frequency) throw bad('Frequência inválida');
    if (!(count >= 1 && count <= 600)) throw bad('Quantidade de parcelas inválida (1 a 600)');
    const start = isDate(b.start_date) ? b.start_date : await today();
    const firstDue = isDate(b.first_due_date) ? b.first_due_date
      : frequency === 'monthly' ? F.addMonths(start, 1) : F.addDays(start, { biweekly: 14, weekly: 7, daily: 1 }[frequency]);
    const g = await DB.getSettings(db);
    const num = (v, d) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : Number(d));
    return { principal, rate, method, frequency, count, start, firstDue,
      lateFee: num(b.late_fee_percent, g.default_late_fee_percent), lateDaily: num(b.late_interest_daily, g.default_late_interest_daily), notes: str(b.notes, 4000) };
  }
  const schedule = (inp) => F.buildSchedule({ principalCents: inp.principal, rate: inp.rate, method: inp.method, count: inp.count, firstDueDate: inp.firstDue, frequency: inp.frequency });

  api.post('/loans/simulate', async (req, res) => {
    const inp = await loanInput(req.body || {});
    const rows = schedule(inp);
    const total = rows.reduce((s, r) => s + r.amount_cents, 0);
    res.json({ installments: rows, total_cents: total, interest_cents: total - inp.principal, first_due_date: inp.firstDue });
  });

  api.post('/loans', async (req, res) => {
    const b = req.body || {};
    const inp = await loanInput(b);
    const rows = schedule(inp);
    const total = rows.reduce((s, r) => s + r.amount_cents, 0);
    let client = null;
    let ownerId;
    if (b.new_client) {
      const nc = clientPayload(b.new_client);
      if (!nc.phone) throw bad('Informe o WhatsApp do cliente para receber as cobranças');
      ownerId = await writeOwner(req, b.owner_id);
      client = nc;
    } else {
      const c = await clientFor(req, b.client_id);
      ownerId = c.owner_id;
      client = c;
    }
    const loanId = await db.tx(async (q) => {
      if (!client.id) client = await insertClient(q, ownerId, client);
      const [l] = await q.query(`INSERT INTO loans(owner_id, client_id, principal_cents, interest_rate, method, frequency, installments_count, start_date, first_due_date,
        late_fee_percent, late_interest_daily, total_cents, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [ownerId, client.id, inp.principal, inp.rate, inp.method, inp.frequency, inp.count, inp.start, inp.firstDue, inp.lateFee, inp.lateDaily, total, inp.notes]);
      for (const r of rows) {
        await q.query('INSERT INTO installments(loan_id, number, due_date, amount_cents, principal_cents, interest_cents) VALUES ($1,$2,$3,$4,$5,$6)',
          [l.id, r.number, r.due_date, r.amount_cents, r.principal_cents, r.interest_cents]);
      }
      await logNote(q, { ownerId, clientId: client.id, loanId: l.id, body: `Empréstimo #${l.id} liberado: ${F.formatBRL(inp.principal)} em ${inp.count}x (total ${F.formatBRL(total)}).` });
      return l.id;
    });
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [loanId]);
    let confirmation = null;
    const s = await DB.accountSettings(db, ownerId);
    if (b.send_confirmation ?? s.send_release_message === '1') {
      const tpl = await db.one("SELECT body FROM templates WHERE name ILIKE 'Confirmação do empréstimo%' ORDER BY id LIMIT 1");
      if (tpl) {
        const body = M.render(tpl.body, await M.buildContext(db, { settings: s, client, loan }));
        confirmation = await withLink(await M.dispatch(db, { ownerId, client, loanId, channel: 'whatsapp', kind: 'release', body, settings: s }), client.phone);
      }
    }
    res.status(201).json({ ...(await loanWithState(loan)), client_id: client.id, confirmation });
  });

  api.get('/loans', async (req, res) => {
    const p = [];
    const w = where(req, 'l.owner_id', p);
    let f = '';
    if (['active', 'paid', 'canceled'].includes(req.query.status)) { p.push(req.query.status); f = `AND l.status=$${p.length}`; }
    const rows = await db.query(`SELECT l.*, c.name AS client_name, c.phone AS client_phone FROM loans l JOIN clients c ON c.id=l.client_id
      WHERE ${w} ${f} ORDER BY l.start_date DESC, l.id DESC`, p);
    const ref = await today();
    const names = await accountNames();
    const out = [];
    for (const l of rows) out.push({ ...summarize(await loanWithState(l, ref)), account_name: names[l.owner_id] });
    res.json(out);
  });

  api.get('/loans/:id', async (req, res) => {
    const l = await loanFor(req, req.params.id);
    const client = await db.one('SELECT * FROM clients WHERE id=$1', [l.client_id]);
    const payments = await db.query('SELECT p.*, i.number FROM payments p JOIN installments i ON i.id=p.installment_id WHERE p.loan_id=$1 ORDER BY p.paid_at DESC, p.id DESC', [l.id]);
    res.json({ ...(await loanWithState(l)), client, payments, account_name: (await accountNames())[l.owner_id] });
  });

  api.put('/loans/:id', async (req, res) => {
    const l = await loanFor(req, req.params.id);
    const b = req.body || {};
    await db.query('UPDATE loans SET notes=$1, late_fee_percent=$2, late_interest_daily=$3 WHERE id=$4',
      [b.notes ?? l.notes, b.late_fee_percent != null ? Number(b.late_fee_percent) : l.late_fee_percent, b.late_interest_daily != null ? Number(b.late_interest_daily) : l.late_interest_daily, l.id]);
    res.json(await loanWithState(await db.one('SELECT * FROM loans WHERE id=$1', [l.id])));
  });

  api.post('/loans/:id/cancel', async (req, res) => {
    const l = await loanFor(req, req.params.id);
    await db.tx(async (q) => {
      await q.query("UPDATE loans SET status='canceled' WHERE id=$1", [l.id]);
      await q.query("UPDATE installments SET status='canceled' WHERE loan_id=$1 AND status='open'", [l.id]);
      await logNote(q, { ownerId: l.owner_id, clientId: l.client_id, loanId: l.id, body: `Empréstimo #${l.id} cancelado.${req.body?.reason ? ' Motivo: ' + str(req.body.reason, 300) : ''}` });
    });
    res.json(await loanWithState(await db.one('SELECT * FROM loans WHERE id=$1', [l.id])));
  });

  api.delete('/loans/:id', async (req, res) => {
    const l = await loanFor(req, req.params.id);
    await db.query('DELETE FROM loans WHERE id=$1', [l.id]);
    res.json({ ok: true });
  });

  async function refreshLoanStatus(q, loanId) {
    const [l] = await q.query('SELECT status FROM loans WHERE id=$1', [loanId]);
    if (l.status === 'canceled') return;
    const [{ n }] = await q.query("SELECT COUNT(*)::int n FROM installments WHERE loan_id=$1 AND status='open'", [loanId]);
    await q.query('UPDATE loans SET status=$1 WHERE id=$2', [n === 0 ? 'paid' : 'active', loanId]);
  }

  api.post('/installments/:id/pay', async (req, res) => {
    const b = req.body || {};
    const inst = await installmentFor(req, req.params.id);
    if (inst.status !== 'open') throw bad('Parcela não está em aberto');
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [inst.loan_id]);
    if (loan.status !== 'active') throw bad('Empréstimo não está ativo');
    const paidAt = isDate(b.paid_at) ? b.paid_at : await today();
    let amount = int(b.amount_cents);
    if (!(amount > 0)) throw bad('Informe o valor recebido');
    const total = amount;
    const applied = await db.tx(async (q) => {
      const out = [];
      if (b.waive_penalty) await q.query('UPDATE installments SET waived_penalty=TRUE WHERE id=$1', [inst.id]);
      const others = b.carry_over !== false
        ? (await q.query("SELECT id FROM installments WHERE loan_id=$1 AND status='open' AND id<>$2 ORDER BY number", [loan.id, inst.id])).map((r) => r.id) : [];
      for (const id of [inst.id, ...others]) {
        if (amount <= 0) break;
        const [cur] = await q.query('SELECT * FROM installments WHERE id=$1', [id]);
        const st = F.installmentState(cur, loan, paidAt);
        const part = Math.min(amount, st.remaining_cents);
        if (part <= 0) continue;
        const newPaid = cur.paid_cents + part;
        const done = newPaid >= st.updated_amount_cents;
        await q.query('UPDATE installments SET paid_cents=$1, status=$2, penalty_cents=$3, paid_at=$4 WHERE id=$5',
          [newPaid, done ? 'paid' : 'open', done ? st.current_penalty_cents : 0, done ? paidAt : null, id]);
        await q.query('INSERT INTO payments(installment_id, loan_id, amount_cents, paid_at, method, notes) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, loan.id, part, paidAt, str(b.method || 'pix', 30), str(b.notes, 300)]);
        out.push({ installment_id: id, number: cur.number, amount_cents: part, settled: done });
        amount -= part;
      }
      if (!out.length) throw bad('Nada a pagar nesta parcela');
      await refreshLoanStatus(q, loan.id);
      await logNote(q, { ownerId: loan.owner_id, clientId: loan.client_id, loanId: loan.id, installmentId: inst.id, kind: 'receipt',
        body: `Pagamento recebido: ${F.formatBRL(total - amount)} (${out.map((a) => `parcela ${a.number}${a.settled ? ' quitada' : ' parcial'}`).join(', ')}).` });
      return out;
    });
    const client = await db.one('SELECT * FROM clients WHERE id=$1', [loan.client_id]);
    const s = await DB.accountSettings(db, loan.owner_id);
    let receipt = null;
    if (b.send_receipt ?? s.send_receipt_on_payment === '1') {
      const tpl = await db.one("SELECT body FROM templates WHERE name ILIKE 'Recibo%' ORDER BY id LIMIT 1");
      if (tpl) {
        const fresh = await db.one('SELECT * FROM installments WHERE id=$1', [inst.id]);
        const freshLoan = await db.one('SELECT * FROM loans WHERE id=$1', [loan.id]);
        const body = M.render(tpl.body, await M.buildContext(db, { settings: s, client, loan: freshLoan, installment: fresh, extra: { valor_pago: F.formatBRL(total - amount) } }));
        receipt = await withLink(await M.dispatch(db, { ownerId: loan.owner_id, client, loanId: loan.id, installmentId: inst.id, channel: 'whatsapp', kind: 'receipt', body, settings: s }), client.phone);
      }
    }
    res.json({ applied, leftover_cents: amount, receipt, loan: await loanWithState(await db.one('SELECT * FROM loans WHERE id=$1', [loan.id])) });
  });

  api.put('/installments/:id', async (req, res) => {
    const inst = await installmentFor(req, req.params.id);
    if (inst.status !== 'open') throw bad('Só é possível editar parcelas em aberto');
    const b = req.body || {};
    const due = isDate(b.due_date) ? b.due_date : inst.due_date;
    const amount = b.amount_cents != null ? int(b.amount_cents) : inst.amount_cents;
    if (!(amount > 0)) throw bad('Valor inválido');
    const waived = b.waived_penalty != null ? !!b.waived_penalty : inst.waived_penalty;
    const diff = amount - inst.amount_cents;
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [inst.loan_id]);
    await db.tx(async (q) => {
      await q.query('UPDATE installments SET due_date=$1, amount_cents=$2, interest_cents=GREATEST(0, interest_cents + $3), waived_penalty=$4 WHERE id=$5', [due, amount, diff, waived, inst.id]);
      await q.query('UPDATE loans SET total_cents=total_cents + $1 WHERE id=$2', [diff, loan.id]);
      await logNote(q, { ownerId: loan.owner_id, clientId: loan.client_id, loanId: loan.id, installmentId: inst.id,
        body: `Parcela ${inst.number} renegociada: venc. ${F.formatDateBR(inst.due_date)} → ${F.formatDateBR(due)}, valor ${F.formatBRL(inst.amount_cents)} → ${F.formatBRL(amount)}${waived ? ', encargos isentos' : ''}.` });
    });
    res.json(await loanWithState(await db.one('SELECT * FROM loans WHERE id=$1', [loan.id])));
  });

  api.delete('/payments/:id', async (req, res) => {
    const p = await db.one('SELECT p.*, l.owner_id, l.client_id FROM payments p JOIN loans l ON l.id=p.loan_id WHERE p.id=$1', [int(req.params.id)]);
    if (!p) throw notFound('Pagamento');
    assertAccess(req, p.owner_id);
    await db.tx(async (q) => {
      const [inst] = await q.query('SELECT * FROM installments WHERE id=$1', [p.installment_id]);
      await q.query("UPDATE installments SET paid_cents=GREATEST(0, paid_cents - $1), status=CASE WHEN status='paid' THEN 'open' ELSE status END, penalty_cents=0, paid_at=NULL WHERE id=$2", [p.amount_cents, inst.id]);
      await q.query('DELETE FROM payments WHERE id=$1', [p.id]);
      await refreshLoanStatus(q, p.loan_id);
      await logNote(q, { ownerId: p.owner_id, clientId: p.client_id, loanId: p.loan_id, body: `Pagamento de ${F.formatBRL(p.amount_cents)} (parcela ${inst.number}) estornado.` });
    });
    res.json(await loanWithState(await db.one('SELECT * FROM loans WHERE id=$1', [p.loan_id])));
  });

  // ---------- Cobranças ----------
  api.get('/collections', async (req, res) => {
    const ref = await today();
    const days = Math.min(90, Math.max(1, int(req.query.days, 7)));
    const limit = F.addDays(ref, days);
    const names = await accountNames();
    const list = (await openInstallments(ref, scope(req))).filter((i) => i.due_date <= limit);
    const out = [];
    for (const i of list) {
      const last = await db.one("SELECT created_at, kind, status FROM messages WHERE installment_id=$1 AND direction='out' ORDER BY id DESC LIMIT 1", [i.id]);
      out.push({ ...i, account_name: names[i.owner_id], last_message: last });
    }
    res.json({
      today: ref,
      overdue: out.filter((i) => i.situation === 'overdue').sort((a, b) => b.days_late - a.days_late),
      due_today: out.filter((i) => i.situation === 'due_today'),
      upcoming: out.filter((i) => i.situation === 'open'),
    });
  });

  // ---------- Mensagens ----------
  api.get('/messages', async (req, res) => {
    const p = [];
    const conds = [where(req, 'm.owner_id', p)];
    for (const k of ['status', 'direction', 'channel']) if (req.query[k]) { p.push(String(req.query[k])); conds.push(`m.${k}=$${p.length}`); }
    p.push(Math.min(1000, int(req.query.limit, 200)));
    const rows = await db.query(`SELECT m.*, COALESCE(c.name, a.name) AS person_name, COALESCE(c.phone, a.phone, m.phone) AS person_phone
      FROM messages m LEFT JOIN clients c ON c.id=m.client_id LEFT JOIN applications a ON a.id=m.application_id
      WHERE ${conds.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT $${p.length}`, p);
    const names = await accountNames();
    const out = [];
    for (const m of rows) out.push({ ...(await withLink(m, m.person_phone)), account_name: names[m.owner_id] });
    res.json(out);
  });

  async function messageFor(req, id) {
    const m = await db.one('SELECT * FROM messages WHERE id=$1', [int(id)]);
    if (!m) throw notFound('Mensagem');
    assertAccess(req, m.owner_id);
    return m;
  }
  api.post('/messages/:id/mark-sent', async (req, res) => {
    const m = await messageFor(req, req.params.id);
    await db.query("UPDATE messages SET status='sent', sent_at=now(), error=NULL WHERE id=$1", [m.id]);
    res.json({ ok: true });
  });
  api.post('/messages/:id/retry', async (req, res) => {
    const m = await messageFor(req, req.params.id);
    if (m.direction !== 'out' || m.channel !== 'whatsapp') throw bad('Mensagem não pode ser reenviada');
    let status, error = null, providerId = null;
    try {
      const r = await M.sendWhatsApp(await DB.accountSettings(db, m.owner_id), m.phone, m.body);
      status = r.status; providerId = r.providerId || null;
    } catch (e) { status = 'failed'; error = e.message; }
    const row = await db.one("UPDATE messages SET status=$1, error=$2, provider_id=$3, sent_at=CASE WHEN $1='sent' THEN now() ELSE NULL END WHERE id=$4 RETURNING *", [status, error, providerId, m.id]);
    res.json(await withLink(row));
  });
  api.delete('/messages/:id', async (req, res) => {
    const m = await messageFor(req, req.params.id);
    await db.query('DELETE FROM messages WHERE id=$1', [m.id]);
    res.json({ ok: true });
  });

  // ---------- Modelos, regras e documentos exigidos (edição só pela central) ----------
  api.get('/templates', async (req, res) => res.json(await db.query('SELECT * FROM templates ORDER BY id')));
  api.post('/templates', async (req, res) => {
    adminOnly(req);
    const { name, body } = req.body || {};
    if (!name || !body) throw bad('Informe nome e texto');
    res.status(201).json(await db.one('INSERT INTO templates(name, body) VALUES ($1,$2) RETURNING *', [str(name, 120), str(body, 4000)]));
  });
  api.put('/templates/:id', async (req, res) => {
    adminOnly(req);
    const { name, body } = req.body || {};
    if (!name || !body) throw bad('Informe nome e texto');
    res.json(await db.one('UPDATE templates SET name=$1, body=$2 WHERE id=$3 RETURNING *', [str(name, 120), str(body, 4000), int(req.params.id)]));
  });
  api.delete('/templates/:id', async (req, res) => {
    adminOnly(req);
    if (await db.one('SELECT 1 FROM rules WHERE template_id=$1', [int(req.params.id)])) throw bad('Modelo em uso por uma regra de automação');
    await db.query('DELETE FROM templates WHERE id=$1', [int(req.params.id)]);
    res.json({ ok: true });
  });

  async function ruleInput(b) {
    if (!b.name) throw bad('Informe o nome da regra');
    if (!['before_due', 'on_due', 'after_due'].includes(b.trigger)) throw bad('Gatilho inválido');
    if (!(await db.one('SELECT 1 FROM templates WHERE id=$1', [int(b.template_id)]))) throw bad('Selecione um modelo');
    return [str(b.name, 120), b.trigger, Math.max(0, int(b.days)), Math.max(0, int(b.repeat_every)), Math.max(0, int(b.max_repeats)),
      int(b.template_id), b.channel === 'crm' ? 'crm' : 'whatsapp', !(b.active === false || b.active === 0)];
  }
  api.get('/rules', async (req, res) => res.json(await db.query('SELECT r.*, t.name AS template_name FROM rules r JOIN templates t ON t.id=r.template_id ORDER BY r.id')));
  api.post('/rules', async (req, res) => {
    adminOnly(req);
    res.status(201).json(await db.one('INSERT INTO rules(name, trigger, days, repeat_every, max_repeats, template_id, channel, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', await ruleInput(req.body || {})));
  });
  api.put('/rules/:id', async (req, res) => {
    adminOnly(req);
    res.json(await db.one('UPDATE rules SET name=$1, trigger=$2, days=$3, repeat_every=$4, max_repeats=$5, template_id=$6, channel=$7, active=$8 WHERE id=$9 RETURNING *',
      [...(await ruleInput(req.body || {})), int(req.params.id)]));
  });
  api.delete('/rules/:id', async (req, res) => {
    adminOnly(req);
    await db.query('DELETE FROM rules WHERE id=$1', [int(req.params.id)]);
    res.json({ ok: true });
  });

  api.get('/document-types', async (req, res) => res.json(await db.query('SELECT * FROM document_types ORDER BY sort, id')));
  function docTypeInput(b) {
    const name = str(b.name, 120);
    if (!name) throw bad('Informe o nome do documento');
    return [name, ['image', 'video', 'file'].includes(b.kind) ? b.kind : 'image', str(b.instructions, 500), !(b.required === false || b.required === 'false'), int(b.sort), !(b.active === false || b.active === 'false')];
  }
  api.post('/document-types', async (req, res) => {
    adminOnly(req);
    res.status(201).json(await db.one('INSERT INTO document_types(name, kind, instructions, required, sort, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', docTypeInput(req.body || {})));
  });
  api.put('/document-types/:id', async (req, res) => {
    adminOnly(req);
    res.json(await db.one('UPDATE document_types SET name=$1, kind=$2, instructions=$3, required=$4, sort=$5, active=$6 WHERE id=$7 RETURNING *', [...docTypeInput(req.body || {}), int(req.params.id)]));
  });
  api.delete('/document-types/:id', async (req, res) => {
    adminOnly(req);
    await db.query('UPDATE document_types SET active=FALSE WHERE id=$1', [int(req.params.id)]);
    res.json({ ok: true });
  });

  api.post('/automations/run', async (req, res) => {
    res.json(await runAutomations(db, { force: true, dryRun: !!req.body?.dryRun, ownerId: scope(req) }));
  });

  // ---------- Cadastros (análise de documentos) ----------
  api.get('/applications', async (req, res) => {
    const p = [];
    const conds = [where(req, 'a.owner_id', p)];
    if (req.query.status) { p.push(String(req.query.status)); conds.push(`a.status=$${p.length}`); }
    const rows = await db.query(`SELECT a.*,
        (SELECT COUNT(*)::int FROM application_files f WHERE f.application_id=a.id) AS files_total,
        (SELECT COUNT(*)::int FROM application_files f WHERE f.application_id=a.id AND f.status='approved') AS files_approved,
        (SELECT COUNT(*)::int FROM application_files f WHERE f.application_id=a.id AND f.status='rejected') AS files_rejected
      FROM applications a WHERE ${conds.join(' AND ')} ORDER BY COALESCE(a.submitted_at, a.created_at) DESC LIMIT 300`, p);
    const names = await accountNames();
    res.json(rows.map((a) => ({ ...a, token: undefined, account_name: names[a.owner_id] })));
  });

  api.post('/applications', async (req, res) => {
    const ownerId = await writeOwner(req, req.body?.owner_id);
    const phone = str(req.body?.phone, 30);
    if (phone.replace(/\D/g, '').length < 10) throw bad('Informe o WhatsApp com DDD');
    const a = await db.one("INSERT INTO applications(owner_id, token, source, name, phone) VALUES ($1,$2,'manual',$3,$4) RETURNING *", [ownerId, DB.randomToken(16), str(req.body?.name, 120) || null, phone]);
    const link = M.applicationLink(a.token, baseUrl(req));
    let message = null;
    if (req.body?.send) {
      const s = await DB.accountSettings(db, ownerId);
      const body = M.render(s.bot_welcome, await M.buildContext(db, { settings: s, application: a, baseUrl: baseUrl(req) }));
      message = await withLink(await M.dispatch(db, { ownerId, application: a, channel: 'whatsapp', kind: 'signup_link', body, settings: s }));
    }
    res.status(201).json({ id: a.id, link, message });
  });

  api.get('/applications/:id', async (req, res) => {
    const a = await applicationFor(req, req.params.id);
    const files = await db.query('SELECT * FROM application_files WHERE application_id=$1 ORDER BY id', [a.id]);
    const types = await db.query('SELECT * FROM document_types WHERE active ORDER BY sort, id');
    const messages = await db.query('SELECT * FROM messages WHERE application_id=$1 ORDER BY created_at DESC, id DESC LIMIT 200', [a.id]);
    await db.query("UPDATE messages SET status='read' WHERE application_id=$1 AND direction='in' AND status='received'", [a.id]);
    const s = await DB.accountSettings(db, a.owner_id);
    res.json({ ...a, token: undefined, link: M.applicationLink(a.token, baseUrl(req)), account_name: (await accountNames())[a.owner_id],
      wa_link: a.phone ? M.waLink(a.phone, '', s.default_country_code) : null, files, document_types: types, messages });
  });

  api.put('/application-files/:id', async (req, res) => {
    const f = await db.one('SELECT f.*, a.owner_id, a.status AS app_status FROM application_files f JOIN applications a ON a.id=f.application_id WHERE f.id=$1', [int(req.params.id)]);
    if (!f) throw notFound('Arquivo');
    assertAccess(req, f.owner_id);
    const status = ['approved', 'rejected', 'pending'].includes(req.body?.status) ? req.body.status : null;
    if (!status) throw bad('Situação inválida');
    const reason = status === 'rejected' ? str(req.body?.reason, 300) : null;
    if (status === 'rejected' && !reason) throw bad('Informe o motivo da recusa');
    res.json(await db.one('UPDATE application_files SET status=$1, reject_reason=$2, reviewed_at=now() WHERE id=$3 RETURNING *', [status, reason, f.id]));
  });

  api.get('/files/:id', async (req, res) => {
    const f = await db.one('SELECT f.*, a.owner_id FROM application_files f JOIN applications a ON a.id=f.application_id WHERE f.id=$1', [int(req.params.id)]);
    if (!f) throw notFound('Arquivo');
    assertAccess(req, f.owner_id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${f.label.replace(/[^\w.\- ]+/g, '_')}.${f.pathname.split('.').pop()}"`);
    await storage.stream(f.pathname, res, req, f.content_type);
  });

  async function notifyApplicant(req, a, template, extra, kind) {
    const s = await DB.accountSettings(db, a.owner_id);
    const body = M.render(template, await M.buildContext(db, { settings: s, application: a, extra, baseUrl: baseUrl(req) }));
    return withLink(await M.dispatch(db, { ownerId: a.owner_id, application: a, channel: 'whatsapp', kind, body, settings: s }));
  }

  api.post('/applications/:id/request-changes', async (req, res) => {
    const a = await applicationFor(req, req.params.id);
    if (['approved', 'rejected'].includes(a.status)) throw bad('Cadastro já finalizado');
    const rejected = await db.query("SELECT label, reject_reason FROM application_files WHERE application_id=$1 AND status='rejected'", [a.id]);
    const note = str(req.body?.note, 1000);
    if (!rejected.length && !note) throw bad('Recuse algum documento ou escreva o que precisa ser corrigido');
    const pend = [...rejected.map((f) => `• ${f.label}: ${f.reject_reason}`), ...(note ? [`• ${note}`] : [])].join('\n');
    await db.tx(async (q) => {
      await q.query("UPDATE applications SET status='needs_changes', review_notes=$1, decided_at=now(), updated_at=now() WHERE id=$2", [pend, a.id]);
      await logNote(q, { ownerId: a.owner_id, applicationId: a.id, body: `Correções solicitadas:\n${pend}` });
    });
    const s = await DB.getSettings(db);
    const message = req.body?.notify === false ? null : await notifyApplicant(req, { ...a, status: 'needs_changes' }, s.msg_needs_changes, { pendencias: pend }, 'review');
    res.json({ ok: true, message });
  });

  api.post('/applications/:id/reject', async (req, res) => {
    const a = await applicationFor(req, req.params.id);
    if (a.status === 'approved') throw bad('Cadastro já aprovado');
    const note = str(req.body?.note, 1000);
    await db.tx(async (q) => {
      await q.query("UPDATE applications SET status='rejected', review_notes=$1, decided_at=now(), updated_at=now() WHERE id=$2", [note || null, a.id]);
      await logNote(q, { ownerId: a.owner_id, applicationId: a.id, body: `Cadastro recusado.${note ? ' ' + note : ''}` });
    });
    const s = await DB.getSettings(db);
    const message = req.body?.notify ? await notifyApplicant(req, a, s.msg_rejected, {}, 'review') : null;
    res.json({ ok: true, message });
  });

  api.post('/applications/:id/approve', async (req, res) => {
    const a = await applicationFor(req, req.params.id);
    if (a.status === 'approved') throw bad('Cadastro já aprovado');
    if (a.status === 'rejected') throw bad('Cadastro recusado');
    if (!req.body?.force) {
      const pending = await db.val("SELECT COUNT(*)::int FROM application_files WHERE application_id=$1 AND status='pending'", [a.id]);
      const missing = await db.query(`SELECT name FROM document_types t WHERE active AND required AND NOT EXISTS
        (SELECT 1 FROM application_files f WHERE f.application_id=$1 AND f.document_type_id=t.id AND f.status='approved')`, [a.id]);
      if (pending || missing.length) {
        throw bad(`Ainda há ${pending ? `${pending} documento(s) aguardando análise` : ''}${pending && missing.length ? ' e ' : ''}${missing.length ? `documento(s) obrigatório(s) sem aprovação (${missing.map((m) => m.name).join(', ')})` : ''}. Revise ou confirme a aprovação mesmo assim.`);
      }
    }
    if (!a.name) throw bad('O cadastro não tem nome');
    const clientId = await db.tx(async (q) => {
      const c = await insertClient(q, a.owner_id, clientPayload({
        name: a.name, phone: a.phone, document: a.document, email: a.email, address: a.address, birth_date: a.birth_date,
        occupation: a.occupation, income_cents: a.income_cents, notes: a.client_notes ? `Observação do cadastro: ${a.client_notes}` : '',
      }), a.id);
      await q.query("UPDATE applications SET status='approved', client_id=$1, decided_at=now(), updated_at=now() WHERE id=$2", [c.id, a.id]);
      await q.query('UPDATE messages SET client_id=$1 WHERE application_id=$2', [c.id, a.id]);
      await logNote(q, { ownerId: a.owner_id, clientId: c.id, applicationId: a.id, body: 'Cadastro aprovado — cliente criado.' });
      return c.id;
    });
    const s = await DB.getSettings(db);
    const message = req.body?.notify === false ? null : await notifyApplicant(req, a, s.msg_approved, {}, 'review');
    res.json({ ok: true, client_id: clientId, message });
  });

  api.delete('/applications/:id', async (req, res) => {
    const a = await applicationFor(req, req.params.id);
    if (a.status === 'approved') throw bad('Cadastro aprovado não pode ser excluído');
    const files = await db.query('SELECT pathname FROM application_files WHERE application_id=$1', [a.id]);
    await db.query('DELETE FROM applications WHERE id=$1', [a.id]);
    for (const f of files) await storage.remove(f.pathname);
    res.json({ ok: true });
  });

  // ---------- Backups (somente administradores) ----------
  api.get('/backups', async (req, res) => {
    adminOnly(req);
    let list = [];
    let error = null;
    try { list = (await backup.listBackups({ dir: opts.backupDir })).slice(0, 120); } catch (e) { error = e.message; }
    res.json({ last: await backup.lastStatus(db), list, error, encrypted: !!process.env.BACKUP_ENCRYPTION_KEY, retention_days: 90 });
  });
  api.post('/backups/run', async (req, res) => {
    adminOnly(req);
    res.json(await backup.runBackup(db, { storage, dir: opts.backupDir }));
  });
  api.get('/backups/download', async (req, res) => {
    adminOnly(req);
    const pathname = String(req.query.pathname || '');
    if (!/^db\/[\w.\-/]+$/.test(pathname) || pathname.includes('..')) throw bad('Backup inválido');
    const buf = await backup.target({ dir: opts.backupDir }).read(pathname);
    const name = pathname.split('/').pop();
    if (req.query.format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/\.gz(\.enc)?$/, '')}"`);
      return res.send(JSON.stringify(backup.open(buf)));
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buf);
  });

  // ---------- Relatórios ----------
  api.get('/reports', async (req, res) => {
    const ref = await today();
    const from = isDate(req.query.from) ? req.query.from : ref.slice(0, 8) + '01';
    const to = isDate(req.query.to) ? req.query.to : ref;
    const p = [];
    const w = where(req, 'l.owner_id', p);
    const n = p.length;
    const payments = await db.query(`SELECT p.*, i.number, c.name AS client_name, l.owner_id FROM payments p JOIN installments i ON i.id=p.installment_id
      JOIN loans l ON l.id=p.loan_id JOIN clients c ON c.id=l.client_id WHERE ${w} AND p.paid_at BETWEEN $${n + 1} AND $${n + 2} ORDER BY p.paid_at`, [...p, from, to]);
    const loans = await db.query(`SELECT l.*, c.name AS client_name FROM loans l JOIN clients c ON c.id=l.client_id
      WHERE ${w} AND l.start_date BETWEEN $${n + 1} AND $${n + 2} AND l.status<>'canceled' ORDER BY l.start_date`, [...p, from, to]);
    const due = await db.one(`SELECT COALESCE(SUM(i.amount_cents),0)::bigint s, COUNT(*)::int c FROM installments i JOIN loans l ON l.id=i.loan_id
      WHERE ${w} AND i.due_date BETWEEN $${n + 1} AND $${n + 2} AND i.status<>'canceled'`, [...p, from, to]);
    const onTime = await db.val(`SELECT COUNT(*)::int FROM installments i JOIN loans l ON l.id=i.loan_id
      WHERE ${w} AND i.due_date BETWEEN $${n + 1} AND $${n + 2} AND i.status='paid' AND i.paid_at <= i.due_date`, [...p, from, to]);
    const byMethod = {};
    for (const x of payments) byMethod[x.method || 'outro'] = (byMethod[x.method || 'outro'] || 0) + x.amount_cents;
    const names = await accountNames();
    const byAccount = {};
    for (const x of payments) byAccount[names[x.owner_id]] = (byAccount[names[x.owner_id]] || 0) + x.amount_cents;
    res.json({ from, to, payments, loans, received_cents: payments.reduce((s, x) => s + x.amount_cents, 0), lent_cents: loans.reduce((s, l) => s + l.principal_cents, 0),
      expected_cents: due.s, expected_count: due.c, paid_on_time: onTime, by_method: byMethod, by_account: byAccount });
  });

  function csv(rows, cols) {
    const esc = (v) => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return '﻿' + [cols.map((c) => c[0]).join(';'), ...rows.map((r) => cols.map((c) => esc(c[1](r))).join(';'))].join('\n');
  }
  const money = (c) => (Number(c || 0) / 100).toFixed(2).replace('.', ',');

  api.get('/export/:type', async (req, res) => {
    const ref = await today();
    const names = await accountNames();
    const acc = ['Conta', (r) => names[r.owner_id]];
    const p = [];
    const w = where(req, 'l.owner_id', p);
    let out;
    switch (req.params.type) {
      case 'clientes.csv': {
        const pc = [];
        out = csv(await db.query(`SELECT * FROM clients WHERE ${where(req, 'owner_id', pc)} ORDER BY name`, pc), [acc,
          ['ID', (r) => r.id], ['Nome', (r) => r.name], ['Telefone', (r) => r.phone], ['CPF', (r) => r.document], ['Nascimento', (r) => F.formatDateBR(r.birth_date)],
          ['E-mail', (r) => r.email], ['Endereço', (r) => r.address], ['Profissão', (r) => r.occupation], ['Renda', (r) => money(r.income_cents)], ['Score', (r) => r.score], ['Observações', (r) => r.notes]]);
        break;
      }
      case 'parcelas.csv': {
        const rows = (await db.query(`SELECT i.*, l.late_fee_percent, l.late_interest_daily, l.installments_count, l.owner_id, c.name AS client_name, l.id AS lid
          FROM installments i JOIN loans l ON l.id=i.loan_id JOIN clients c ON c.id=l.client_id WHERE ${w} ORDER BY i.due_date`, p)).map((r) => F.installmentState(r, r, ref));
        out = csv(rows, [acc, ['Empréstimo', (r) => r.lid], ['Cliente', (r) => r.client_name], ['Parcela', (r) => `${r.number}/${r.installments_count}`],
          ['Vencimento', (r) => F.formatDateBR(r.due_date)], ['Valor', (r) => money(r.amount_cents)], ['Pago', (r) => money(r.paid_cents)],
          ['Encargos', (r) => money(r.current_penalty_cents)], ['Restante', (r) => money(r.remaining_cents)], ['Situação', (r) => r.situation],
          ['Dias atraso', (r) => r.days_late], ['Pago em', (r) => F.formatDateBR(r.paid_at)]]);
        break;
      }
      case 'pagamentos.csv':
        out = csv(await db.query(`SELECT p.*, i.number, c.name AS client_name, l.owner_id FROM payments p JOIN installments i ON i.id=p.installment_id
          JOIN loans l ON l.id=p.loan_id JOIN clients c ON c.id=l.client_id WHERE ${w} ORDER BY p.paid_at`, p), [acc,
          ['Data', (r) => F.formatDateBR(r.paid_at)], ['Cliente', (r) => r.client_name], ['Empréstimo', (r) => r.loan_id], ['Parcela', (r) => r.number],
          ['Valor', (r) => money(r.amount_cents)], ['Forma', (r) => r.method], ['Obs', (r) => r.notes]]);
        break;
      case 'emprestimos.csv': {
        const rows = [];
        for (const l of await db.query(`SELECT l.*, c.name AS client_name FROM loans l JOIN clients c ON c.id=l.client_id WHERE ${w} ORDER BY l.start_date`, p)) rows.push(await loanWithState(l, ref));
        out = csv(rows, [acc, ['ID', (r) => r.id], ['Cliente', (r) => r.client_name], ['Data', (r) => F.formatDateBR(r.start_date)], ['Valor emprestado', (r) => money(r.principal_cents)],
          ['Taxa %', (r) => String(r.interest_rate).replace('.', ',')], ['Método', (r) => r.method], ['Frequência', (r) => r.frequency], ['Parcelas', (r) => r.installments_count],
          ['Total', (r) => money(r.total_cents)], ['Pago', (r) => money(r.paid_cents)], ['Saldo', (r) => money(r.balance_cents)], ['Em atraso', (r) => money(r.overdue_cents)], ['Status', (r) => r.status]]);
        break;
      }
      default:
        throw notFound('Exportação');
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}"`);
    res.send(out);
  });

  // ---------- Erros ----------
  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Erro interno: ' + err.message : err.message });
  });

  return app;
}

module.exports = { createApp };
