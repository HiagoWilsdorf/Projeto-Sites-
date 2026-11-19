'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { getSettings, setSettings, tx, DATA_DIR } = require('./db');
const F = require('./finance');
const M = require('./messaging');
const auth = require('./auth');
const { runAutomations } = require('./scheduler');

const SECRET_KEYS = ['wa_cloud_token', 'wa_evolution_apikey', 'wa_zapi_token', 'wa_zapi_client_token'];
const MASK = '••••••••';
const METHODS = ['simple', 'price', 'interest_only'];
const FREQS = ['monthly', 'biweekly', 'weekly', 'daily'];
const STAGES = ['lead', 'analysis', 'approved', 'rejected', 'client'];
const STAGE_LABEL = { lead: 'Novo contato', analysis: 'Em análise', approved: 'Aprovado', rejected: 'Recusado', client: 'Cliente' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (what = 'Registro') => new HttpError(404, `${what} não encontrado`);

const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function createApp(db, { scheduler, docsDir = path.join(DATA_DIR, 'documents') } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '30mb' }));

  const today = () => F.todayIn(getSettings(db).timezone);
  const getClient = (id) => db.prepare('SELECT * FROM clients WHERE id=?').get(int(id));
  const getLoan = (id) => db.prepare('SELECT * FROM loans WHERE id=?').get(int(id));

  // ---------- Webhook de entrada (sem login, protegido por token) ----------
  app.get('/api/webhooks/whatsapp/:token', (req, res) => {
    const s = getSettings(db);
    if (req.params.token !== s.wa_inbound_token) return res.sendStatus(403);
    // Verificação da Meta Cloud API
    if (req.query['hub.mode'] === 'subscribe') return res.send(String(req.query['hub.challenge'] || ''));
    res.send('ok');
  });
  app.post('/api/webhooks/whatsapp/:token', async (req, res) => {
    const s = getSettings(db);
    if (req.params.token !== s.wa_inbound_token) return res.sendStatus(403);
    for (const m of M.parseInbound(req.body)) {
      try { await M.handleInbound(db, m); } catch (e) { console.error('[webhook]', e); }
    }
    res.json({ ok: true });
  });

  // ---------- Autenticação ----------
  auth.routes(app, db);
  const api = express.Router();
  api.use(auth.requireAuth(db));
  app.use('/api', api);

  api.post('/auth/password', (req, res) => {
    const { current, password } = req.body || {};
    if (!auth.verifyPassword(current || '', getSettings(db).password_hash)) throw bad('Senha atual incorreta');
    if (!password || String(password).length < 6) throw bad('A nova senha deve ter pelo menos 6 caracteres');
    setSettings(db, { password_hash: auth.hashPassword(password) });
    res.json({ ok: true });
  });

  // ---------- Helpers de leitura ----------
  function loanWithState(loan, ref = today()) {
    const insts = db.prepare('SELECT * FROM installments WHERE loan_id=? ORDER BY number').all(loan.id)
      .map((i) => F.installmentState(i, loan, ref));
    const open = insts.filter((i) => i.status === 'open');
    const paidCents = insts.reduce((s, i) => s + i.paid_cents, 0);
    return {
      ...loan,
      installments: insts,
      paid_cents: paidCents,
      balance_cents: open.reduce((s, i) => s + i.remaining_cents, 0),
      overdue_cents: open.filter((i) => i.situation === 'overdue').reduce((s, i) => s + i.remaining_cents, 0),
      overdue_count: open.filter((i) => i.situation === 'overdue').length,
      paid_count: insts.filter((i) => i.status === 'paid').length,
      next_due: open[0]?.due_date || null,
      max_days_late: open.reduce((m, i) => Math.max(m, i.days_late), 0),
    };
  }

  function openInstallmentsWithState(ref = today()) {
    const rows = db.prepare(`
      SELECT i.*, l.late_fee_percent, l.late_interest_daily, l.installments_count, l.client_id,
             c.name AS client_name, c.phone AS client_phone
      FROM installments i JOIN loans l ON l.id=i.loan_id JOIN clients c ON c.id=l.client_id
      WHERE i.status='open' AND l.status='active' ORDER BY i.due_date`).all();
    return rows.map((r) => F.installmentState(r, r, ref));
  }

  // ---------- Dashboard ----------
  api.get('/dashboard', (req, res) => {
    const ref = today();
    const open = openInstallmentsWithState(ref);
    const overdue = open.filter((i) => i.situation === 'overdue');
    const in7 = F.addDays(ref, 7);
    const upcoming = open.filter((i) => i.due_date >= ref && i.due_date <= in7);
    const monthStart = ref.slice(0, 8) + '01';

    const receivedMonth = db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE paid_at >= ? AND paid_at <= ?').get(monthStart, ref).s;
    const receivedTotal = db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM payments').get().s;
    const lentTotal = db.prepare("SELECT COALESCE(SUM(principal_cents),0) s FROM loans WHERE status!='canceled'").get().s;
    const activeLoans = db.prepare("SELECT COUNT(*) c FROM loans WHERE status='active'").get().c;
    const clients = db.prepare('SELECT COUNT(*) c FROM clients WHERE archived=0').get().c;

    // Lucro realizado: o que foi pago abate primeiro encargos e juros, depois principal.
    const profit = db.prepare(`SELECT COALESCE(SUM(MIN(paid_cents, interest_cents + penalty_cents)),0) s FROM installments i
      JOIN loans l ON l.id=i.loan_id WHERE l.status!='canceled'`).get().s;
    // Capital na rua: principal ainda não recuperado das parcelas em aberto.
    const principalOut = open.reduce((s, i) => s + Math.max(0, i.principal_cents - Math.max(0, i.paid_cents - i.interest_cents - i.current_penalty_cents)), 0);

    const receivable = open.reduce((s, i) => s + i.remaining_cents, 0);
    const overdueCents = overdue.reduce((s, i) => s + i.remaining_cents, 0);

    const months = [];
    for (let k = 5; k >= 0; k--) {
      const d = F.addMonths(monthStart, -k);
      const end = F.addDays(F.addMonths(d, 1), -1);
      const received = db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE paid_at BETWEEN ? AND ?').get(d, end).s;
      const lent = db.prepare("SELECT COALESCE(SUM(principal_cents),0) s FROM loans WHERE status!='canceled' AND start_date BETWEEN ? AND ?").get(d, end).s;
      months.push({ month: d.slice(0, 7), received, lent });
    }

    res.json({
      today: ref,
      totals: {
        lent_total: lentTotal, received_total: receivedTotal, received_month: receivedMonth,
        receivable, overdue: overdueCents, principal_out: principalOut, profit_realized: profit,
        expected_profit: receivable + receivedTotal - lentTotal,
        active_loans: activeLoans, clients,
        overdue_clients: new Set(overdue.map((i) => i.client_id)).size,
        delinquency_rate: receivable ? overdueCents / receivable : 0,
        pending_manual: db.prepare("SELECT COUNT(*) c FROM messages WHERE status='pending_manual'").get().c,
        failed_messages: db.prepare("SELECT COUNT(*) c FROM messages WHERE status='failed' AND created_at >= datetime('now','-7 days')").get().c,
        unread_inbound: db.prepare("SELECT COUNT(*) c FROM messages WHERE direction='in' AND status='received'").get().c,
        pending_requests: db.prepare("SELECT COUNT(*) c FROM clients WHERE archived=0 AND stage IN ('lead','analysis','approved')").get().c,
      },
      overdue: overdue.slice(0, 20),
      upcoming: upcoming.slice(0, 20),
      months,
    });
  });

  // ---------- Clientes (CRM) ----------
  api.get('/clients', (req, res) => {
    const q = `%${(req.query.q || '').trim()}%`;
    const archived = req.query.archived === '1' ? 1 : 0;
    const stage = String(req.query.stage || 'client');
    const stageSql = stage === 'all' ? "stage!='rejected'" : STAGES.includes(stage) ? `stage='${stage}'` : "stage='client'";
    const rows = db.prepare(`SELECT * FROM clients WHERE archived=? AND ${stageSql} AND (name LIKE ? OR phone LIKE ? OR document LIKE ? OR tags LIKE ?) ORDER BY name`)
      .all(archived, q, q, q, q);
    const ref = today();
    const open = openInstallmentsWithState(ref);
    const byClient = new Map();
    for (const i of open) {
      const c = byClient.get(i.client_id) || { balance: 0, overdue: 0, max_late: 0 };
      c.balance += i.remaining_cents;
      if (i.situation === 'overdue') { c.overdue += i.remaining_cents; c.max_late = Math.max(c.max_late, i.days_late); }
      byClient.set(i.client_id, c);
    }
    res.json(rows.map((c) => {
      const s = byClient.get(c.id) || { balance: 0, overdue: 0, max_late: 0 };
      return { ...c, balance_cents: s.balance, overdue_cents: s.overdue, max_days_late: s.max_late };
    }));
  });

  function clientPayload(b) {
    const name = String(b.name || '').trim();
    if (!name) throw bad('Informe o nome do cliente');
    return {
      name, phone: String(b.phone || '').trim(), document: String(b.document || '').trim(), email: String(b.email || '').trim(),
      address: String(b.address || '').trim(), notes: String(b.notes || ''), tags: String(b.tags || '').trim(),
      score: Math.min(5, Math.max(1, int(b.score, 3))), whatsapp_opt_in: b.whatsapp_opt_in === false || b.whatsapp_opt_in === 0 ? 0 : 1,
      stage: STAGES.includes(b.stage) ? b.stage : 'client', requested_cents: Math.max(0, int(b.requested_cents)),
    };
  }

  api.post('/clients', (req, res) => {
    const c = clientPayload(req.body || {});
    const r = db.prepare("INSERT INTO clients(name, phone, document, email, address, notes, tags, score, whatsapp_opt_in, stage, requested_cents, source, stage_updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'manual',datetime('now'))")
      .run(c.name, c.phone, c.document, c.email, c.address, c.notes, c.tags, c.score, c.whatsapp_opt_in, c.stage, c.requested_cents);
    res.status(201).json(getClient(r.lastInsertRowid));
  });

  api.get('/clients/:id', (req, res) => {
    const c = getClient(req.params.id);
    if (!c) throw notFound('Cliente');
    const loans = db.prepare('SELECT * FROM loans WHERE client_id=? ORDER BY start_date DESC, id DESC').all(c.id).map((l) => {
      const s = loanWithState(l);
      delete s.installments;
      return s;
    });
    const messages = db.prepare('SELECT * FROM messages WHERE client_id=? ORDER BY created_at DESC, id DESC LIMIT 300').all(c.id);
    const payments = db.prepare(`SELECT p.*, i.number FROM payments p JOIN installments i ON i.id=p.installment_id
      JOIN loans l ON l.id=p.loan_id WHERE l.client_id=? ORDER BY p.paid_at DESC, p.id DESC LIMIT 100`).all(c.id);
    // marca mensagens recebidas como lidas
    db.prepare("UPDATE messages SET status='read' WHERE client_id=? AND direction='in' AND status='received'").run(c.id);
    const s = getSettings(db);
    const documents = db.prepare('SELECT id, name, filename, mime, size, created_at FROM documents WHERE client_id=? ORDER BY id DESC').all(c.id);
    res.json({ ...c, doc_checklist: safeJSON(c.doc_checklist), required_documents: requiredDocs(s), wa_link: c.phone ? M.waLink(c.phone, '', s.default_country_code) : null, loans, messages, payments, documents });
  });

  api.put('/clients/:id', (req, res) => {
    const old = getClient(req.params.id);
    if (!old) throw notFound('Cliente');
    const c = clientPayload({ ...old, ...req.body });
    const archived = req.body.archived != null ? (req.body.archived ? 1 : 0) : old.archived;
    db.prepare('UPDATE clients SET name=?, phone=?, document=?, email=?, address=?, notes=?, tags=?, score=?, whatsapp_opt_in=?, archived=?, requested_cents=? WHERE id=?')
      .run(c.name, c.phone, c.document, c.email, c.address, c.notes, c.tags, c.score, c.whatsapp_opt_in, archived, c.requested_cents, old.id);
    res.json(getClient(old.id));
  });

  api.delete('/clients/:id', (req, res) => {
    const c = getClient(req.params.id);
    if (!c) throw notFound('Cliente');
    const n = db.prepare('SELECT COUNT(*) c FROM loans WHERE client_id=?').get(c.id).c;
    if (n > 0) throw bad('Cliente possui empréstimos. Arquive-o em vez de excluir.');
    tx(db, () => {
      db.prepare('DELETE FROM messages WHERE client_id=?').run(c.id);
      db.prepare('DELETE FROM documents WHERE client_id=?').run(c.id);
      db.prepare('DELETE FROM clients WHERE id=?').run(c.id);
    });
    fs.rmSync(path.join(docsDir, String(c.id)), { recursive: true, force: true });
    res.json({ ok: true });
  });

  api.post('/clients/:id/notes', (req, res) => {
    const c = getClient(req.params.id);
    if (!c) throw notFound('Cliente');
    const body = String(req.body?.body || '').trim();
    if (!body) throw bad('Escreva a anotação');
    const r = db.prepare("INSERT INTO messages(client_id, loan_id, direction, channel, kind, body, status) VALUES (?,?,'note','crm','note',?,'logged')")
      .run(c.id, req.body.loan_id ? int(req.body.loan_id) : null, body);
    res.status(201).json(db.prepare('SELECT * FROM messages WHERE id=?').get(Number(r.lastInsertRowid)));
  });

  // Enviar mensagem avulsa (com ou sem modelo)
  api.post('/clients/:id/messages', async (req, res) => {
    const c = getClient(req.params.id);
    if (!c) throw notFound('Cliente');
    const b = req.body || {};
    const installment = b.installment_id ? db.prepare('SELECT * FROM installments WHERE id=?').get(int(b.installment_id)) : null;
    const loan = installment ? getLoan(installment.loan_id) : b.loan_id ? getLoan(b.loan_id) : null;
    let body = String(b.body || '');
    if (!body && b.template_id) body = db.prepare('SELECT body FROM templates WHERE id=?').get(int(b.template_id))?.body || '';
    body = M.render(body, M.buildContext(db, { client: c, loan, installment })).trim();
    if (!body) throw bad('Mensagem vazia');
    const channel = b.channel === 'crm' ? 'crm' : 'whatsapp';
    const msg = await M.dispatch(db, { client: c, loanId: loan?.id || null, installmentId: installment?.id || null, channel, kind: b.kind || 'manual', body });
    res.status(201).json(withLink(msg, c));
  });

  // ---------- Pedidos (análise antes da liberação) ----------
  const safeJSON = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
  const requiredDocs = (s) => String(s.required_documents || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const logNote = (clientId, body, loanId = null) => db.prepare("INSERT INTO messages(client_id, loan_id, direction, channel, kind, body, status) VALUES (?,?,'note','crm','note',?,'logged')").run(clientId, loanId, body);

  api.get('/pipeline', (req, res) => {
    const docs = requiredDocs(getSettings(db));
    const rows = db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM documents d WHERE d.client_id=c.id) AS doc_files,
        (SELECT body FROM messages m WHERE m.client_id=c.id AND m.direction='in' ORDER BY m.id DESC LIMIT 1) AS last_inbound,
        (SELECT created_at FROM messages m WHERE m.client_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_activity,
        (SELECT COUNT(*) FROM messages m WHERE m.client_id=c.id AND m.direction='in' AND m.status='received') AS unread
      FROM clients c WHERE c.archived=0 AND c.stage IN ('lead','analysis','approved','rejected')
      ORDER BY COALESCE(c.stage_updated_at, c.created_at) DESC`).all();
    const out = { lead: [], analysis: [], approved: [], rejected: [] };
    for (const r of rows) {
      const chk = safeJSON(r.doc_checklist);
      const item = { ...r, docs_ok: docs.filter((d) => chk[d]).length, docs_total: docs.length };
      if (r.stage !== 'rejected' || out.rejected.length < 30) out[r.stage].push(item);
    }
    res.json(out);
  });

  api.post('/clients/:id/stage', (req, res) => {
    const c = getClient(req.params.id);
    if (!c) throw notFound('Cliente');
    const stage = req.body?.stage;
    if (!STAGES.includes(stage)) throw bad('Etapa inválida');
    db.prepare("UPDATE clients SET stage=?, stage_updated_at=datetime('now') WHERE id=?").run(stage, c.id);
    logNote(c.id, `Etapa: ${STAGE_LABEL[c.stage]} → ${STAGE_LABEL[stage]}${req.body?.note ? '. ' + req.body.note : ''}`);
    res.json(getClient(c.id));
  });

  api.put('/clients/:id/checklist', (req, res) => {
    const c = getClient(req.params.id);
    if (!c) throw notFound('Cliente');
    const chk = { ...safeJSON(c.doc_checklist), ...(req.body || {}) };
    for (const k of Object.keys(chk)) if (!chk[k]) delete chk[k];
    db.prepare('UPDATE clients SET doc_checklist=? WHERE id=?').run(JSON.stringify(chk), c.id);
    res.json(chk);
  });

  // ---------- Documentos ----------
  api.post('/clients/:id/documents', (req, res) => {
    const c = getClient(req.params.id);
    if (!c) throw notFound('Cliente');
    const { name, filename, mime, data } = req.body || {};
    if (!data) throw bad('Arquivo vazio');
    const buf = Buffer.from(String(data).replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length || buf.length > 20 * 1024 * 1024) throw bad('Arquivo inválido ou maior que 20 MB');
    const safe = String(filename || 'arquivo').replace(/[^\w.\-]+/g, '_').slice(-80);
    const stored = `${crypto.randomBytes(8).toString('hex')}-${safe}`;
    const dir = path.join(docsDir, String(c.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, stored), buf);
    const r = db.prepare('INSERT INTO documents(client_id, name, filename, mime, size) VALUES (?,?,?,?,?)')
      .run(c.id, String(name || filename || 'Documento').slice(0, 120), stored, String(mime || 'application/octet-stream'), buf.length);
    // marca o item do checklist, se o nome bater
    if (name && requiredDocs(getSettings(db)).includes(name)) {
      const chk = { ...safeJSON(c.doc_checklist), [name]: true };
      db.prepare('UPDATE clients SET doc_checklist=? WHERE id=?').run(JSON.stringify(chk), c.id);
    }
    res.status(201).json(db.prepare('SELECT id, name, filename, mime, size, created_at FROM documents WHERE id=?').get(Number(r.lastInsertRowid)));
  });

  api.get('/documents/:id', (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(int(req.params.id));
    if (!d) throw notFound('Documento');
    const file = path.join(docsDir, String(d.client_id), d.filename);
    if (!fs.existsSync(file)) throw notFound('Arquivo');
    res.setHeader('Content-Type', d.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${d.filename.replace(/^[a-f0-9]+-/, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    fs.createReadStream(file).pipe(res);
  });

  api.delete('/documents/:id', (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(int(req.params.id));
    if (!d) throw notFound('Documento');
    fs.rmSync(path.join(docsDir, String(d.client_id), d.filename), { force: true });
    db.prepare('DELETE FROM documents WHERE id=?').run(d.id);
    res.json({ ok: true });
  });

  api.post('/preview-message', (req, res) => {
    const b = req.body || {};
    const c = b.client_id ? getClient(b.client_id) : { name: 'Cliente Exemplo', phone: '' };
    const installment = b.installment_id ? db.prepare('SELECT * FROM installments WHERE id=?').get(int(b.installment_id)) : null;
    const loan = installment ? getLoan(installment.loan_id) : null;
    res.json({ body: M.render(String(b.body || ''), M.buildContext(db, { client: c, loan, installment })) });
  });

  function withLink(msg, client) {
    if (!msg) return msg;
    const s = getSettings(db);
    const phone = client?.phone ?? db.prepare('SELECT phone FROM clients WHERE id=?').get(msg.client_id)?.phone;
    return { ...msg, wa_link: msg.channel === 'whatsapp' && phone ? M.waLink(phone, msg.body, s.default_country_code) : null };
  }

  // ---------- Empréstimos ----------
  function loanInput(b) {
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
    const start = isDate(b.start_date) ? b.start_date : today();
    let firstDue = isDate(b.first_due_date) ? b.first_due_date : null;
    if (!firstDue) {
      firstDue = frequency === 'monthly' ? F.addMonths(start, 1) : F.addDays(start, { biweekly: 14, weekly: 7, daily: 1 }[frequency]);
    }
    const s = getSettings(db);
    return {
      principal, rate, method, frequency, count, start, firstDue,
      lateFee: b.late_fee_percent !== undefined && b.late_fee_percent !== '' ? Number(b.late_fee_percent) : Number(s.default_late_fee_percent),
      lateDaily: b.late_interest_daily !== undefined && b.late_interest_daily !== '' ? Number(b.late_interest_daily) : Number(s.default_late_interest_daily),
      notes: String(b.notes || ''),
    };
  }

  function schedule(inp) {
    return F.buildSchedule({ principalCents: inp.principal, rate: inp.rate, method: inp.method, count: inp.count, firstDueDate: inp.firstDue, frequency: inp.frequency });
  }

  api.post('/loans/simulate', (req, res) => {
    const inp = loanInput(req.body || {});
    const rows = schedule(inp);
    const total = rows.reduce((s, r) => s + r.amount_cents, 0);
    res.json({ installments: rows, total_cents: total, interest_cents: total - inp.principal, first_due_date: inp.firstDue });
  });

  api.post('/loans', async (req, res) => {
    const b = req.body || {};
    const c = getClient(b.client_id);
    if (!c) throw bad('Selecione um cliente');
    const inp = loanInput(b);
    const rows = schedule(inp);
    const total = rows.reduce((s, r) => s + r.amount_cents, 0);
    const id = tx(db, () => {
      const r = db.prepare(`INSERT INTO loans(client_id, principal_cents, interest_rate, method, frequency, installments_count, start_date, first_due_date,
        late_fee_percent, late_interest_daily, total_cents, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(c.id, inp.principal, inp.rate, inp.method, inp.frequency, inp.count, inp.start, inp.firstDue, inp.lateFee, inp.lateDaily, total, inp.notes);
      const loanId = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT INTO installments(loan_id, number, due_date, amount_cents, principal_cents, interest_cents) VALUES (?,?,?,?,?,?)');
      for (const row of rows) ins.run(loanId, row.number, row.due_date, row.amount_cents, row.principal_cents, row.interest_cents);
      db.prepare("INSERT INTO messages(client_id, loan_id, direction, channel, kind, body, status) VALUES (?,?,'note','crm','note',?,'logged')")
        .run(c.id, loanId, `Empréstimo #${loanId} liberado: ${F.formatBRL(inp.principal)} em ${inp.count}x (total ${F.formatBRL(total)}).`);
      if (c.stage !== 'client') db.prepare("UPDATE clients SET stage='client', stage_updated_at=datetime('now') WHERE id=?").run(c.id);
      return loanId;
    });
    const loan = getLoan(id);
    let confirmation = null;
    const s = getSettings(db);
    if (b.send_confirmation ?? s.send_release_message === '1') {
      const tpl = db.prepare("SELECT body FROM templates WHERE name LIKE 'Empréstimo liberado%' ORDER BY id LIMIT 1").get();
      if (tpl) {
        const body = M.render(tpl.body, M.buildContext(db, { client: c, loan }));
        confirmation = withLink(await M.dispatch(db, { client: c, loanId: id, channel: 'whatsapp', kind: 'release', body }), c);
      }
    }
    res.status(201).json({ ...loanWithState(loan), confirmation });
  });

  api.get('/loans', (req, res) => {
    const status = ['active', 'paid', 'canceled'].includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(`SELECT l.*, c.name AS client_name, c.phone AS client_phone FROM loans l JOIN clients c ON c.id=l.client_id
      ${status ? 'WHERE l.status=?' : ''} ORDER BY l.start_date DESC, l.id DESC`).all(...(status ? [status] : []));
    const ref = today();
    res.json(rows.map((l) => { const s = loanWithState(l, ref); delete s.installments; return s; }));
  });

  api.get('/loans/:id', (req, res) => {
    const l = getLoan(req.params.id);
    if (!l) throw notFound('Empréstimo');
    const c = getClient(l.client_id);
    const payments = db.prepare('SELECT p.*, i.number FROM payments p JOIN installments i ON i.id=p.installment_id WHERE p.loan_id=? ORDER BY p.paid_at DESC, p.id DESC').all(l.id);
    res.json({ ...loanWithState(l), client: c, payments });
  });

  api.put('/loans/:id', (req, res) => {
    const l = getLoan(req.params.id);
    if (!l) throw notFound('Empréstimo');
    const b = req.body || {};
    db.prepare('UPDATE loans SET notes=?, late_fee_percent=?, late_interest_daily=? WHERE id=?')
      .run(b.notes ?? l.notes, b.late_fee_percent != null ? Number(b.late_fee_percent) : l.late_fee_percent,
        b.late_interest_daily != null ? Number(b.late_interest_daily) : l.late_interest_daily, l.id);
    res.json(loanWithState(getLoan(l.id)));
  });

  api.post('/loans/:id/cancel', (req, res) => {
    const l = getLoan(req.params.id);
    if (!l) throw notFound('Empréstimo');
    tx(db, () => {
      db.prepare("UPDATE loans SET status='canceled' WHERE id=?").run(l.id);
      db.prepare("UPDATE installments SET status='canceled' WHERE loan_id=? AND status='open'").run(l.id);
      db.prepare("INSERT INTO messages(client_id, loan_id, direction, channel, kind, body, status) VALUES (?,?,'note','crm','note',?,'logged')")
        .run(l.client_id, l.id, `Empréstimo #${l.id} cancelado.${req.body?.reason ? ' Motivo: ' + req.body.reason : ''}`);
    });
    res.json(loanWithState(getLoan(l.id)));
  });

  api.delete('/loans/:id', (req, res) => {
    const l = getLoan(req.params.id);
    if (!l) throw notFound('Empréstimo');
    tx(db, () => {
      db.prepare('UPDATE messages SET loan_id=NULL, installment_id=NULL WHERE loan_id=?').run(l.id);
      db.prepare('DELETE FROM loans WHERE id=?').run(l.id);
    });
    res.json({ ok: true });
  });

  // ---------- Parcelas e pagamentos ----------
  function refreshLoanStatus(loanId) {
    const l = getLoan(loanId);
    if (l.status === 'canceled') return;
    const open = db.prepare("SELECT COUNT(*) c FROM installments WHERE loan_id=? AND status='open'").get(loanId).c;
    db.prepare('UPDATE loans SET status=? WHERE id=?').run(open === 0 ? 'paid' : 'active', loanId);
  }

  api.post('/installments/:id/pay', async (req, res) => {
    const b = req.body || {};
    let inst = db.prepare('SELECT * FROM installments WHERE id=?').get(int(req.params.id));
    if (!inst) throw notFound('Parcela');
    if (inst.status !== 'open') throw bad('Parcela não está em aberto');
    const loan = getLoan(inst.loan_id);
    if (loan.status !== 'active') throw bad('Empréstimo não está ativo');
    const paidAt = isDate(b.paid_at) ? b.paid_at : today();
    let amount = int(b.amount_cents);
    if (!(amount > 0)) throw bad('Informe o valor recebido');
    const total = amount;

    const applied = tx(db, () => {
      const out = [];
      if (b.waive_penalty) db.prepare('UPDATE installments SET waived_penalty=1 WHERE id=?').run(inst.id);
      // aplica na parcela escolhida e, se sobrar e for permitido, nas seguintes
      const queue = [inst.id, ...(b.carry_over !== false
        ? db.prepare("SELECT id FROM installments WHERE loan_id=? AND status='open' AND id!=? ORDER BY number").all(loan.id, inst.id).map((r) => r.id)
        : [])];
      for (const id of queue) {
        if (amount <= 0) break;
        const cur = db.prepare('SELECT * FROM installments WHERE id=?').get(id);
        const st = F.installmentState(cur, loan, paidAt);
        const part = Math.min(amount, st.remaining_cents);
        if (part <= 0) continue;
        const newPaid = cur.paid_cents + part;
        const done = newPaid >= st.updated_amount_cents;
        db.prepare('UPDATE installments SET paid_cents=?, status=?, penalty_cents=?, paid_at=? WHERE id=?')
          .run(newPaid, done ? 'paid' : 'open', done ? st.current_penalty_cents : 0, done ? paidAt : null, id);
        db.prepare('INSERT INTO payments(installment_id, loan_id, amount_cents, paid_at, method, notes) VALUES (?,?,?,?,?,?)')
          .run(id, loan.id, part, paidAt, String(b.method || 'pix'), String(b.notes || ''));
        out.push({ installment_id: id, number: cur.number, amount_cents: part, settled: done });
        amount -= part;
      }
      if (out.length === 0) throw bad('Nada a pagar nesta parcela');
      refreshLoanStatus(loan.id);
      return out;
    });

    const leftover = amount;
    const client = getClient(loan.client_id);
    db.prepare("INSERT INTO messages(client_id, loan_id, installment_id, direction, channel, kind, body, status) VALUES (?,?,?,'note','crm','receipt',?,'logged')")
      .run(client.id, loan.id, inst.id, `Pagamento recebido: ${F.formatBRL(total - leftover)} (${applied.map((a) => `parcela ${a.number}${a.settled ? ' quitada' : ' parcial'}`).join(', ')}).`);

    let receipt = null;
    const s = getSettings(db);
    if (b.send_receipt ?? s.send_receipt_on_payment === '1') {
      const tpl = db.prepare("SELECT body FROM templates WHERE name LIKE 'Recibo%' ORDER BY id LIMIT 1").get();
      if (tpl) {
        const fresh = db.prepare('SELECT * FROM installments WHERE id=?').get(inst.id);
        const body = M.render(tpl.body, M.buildContext(db, { client, loan: getLoan(loan.id), installment: fresh, extra: { valor_pago: F.formatBRL(total - leftover) } }));
        receipt = withLink(await M.dispatch(db, { client, loanId: loan.id, installmentId: inst.id, channel: 'whatsapp', kind: 'receipt', body }), client);
      }
    }
    res.json({ applied, leftover_cents: leftover, receipt, loan: loanWithState(getLoan(loan.id)) });
  });

  api.put('/installments/:id', (req, res) => {
    const inst = db.prepare('SELECT * FROM installments WHERE id=?').get(int(req.params.id));
    if (!inst) throw notFound('Parcela');
    if (inst.status !== 'open') throw bad('Só é possível editar parcelas em aberto');
    const b = req.body || {};
    const due = isDate(b.due_date) ? b.due_date : inst.due_date;
    const amount = b.amount_cents != null ? int(b.amount_cents) : inst.amount_cents;
    if (!(amount > 0)) throw bad('Valor inválido');
    const waived = b.waived_penalty != null ? (b.waived_penalty ? 1 : 0) : inst.waived_penalty;
    const diff = amount - inst.amount_cents;
    tx(db, () => {
      db.prepare('UPDATE installments SET due_date=?, amount_cents=?, interest_cents=MAX(0, interest_cents + ?), waived_penalty=? WHERE id=?')
        .run(due, amount, diff, waived, inst.id);
      const l = getLoan(inst.loan_id);
      db.prepare('UPDATE loans SET total_cents=total_cents + ? WHERE id=?').run(diff, l.id);
      db.prepare("INSERT INTO messages(client_id, loan_id, installment_id, direction, channel, kind, body, status) VALUES (?,?,?,'note','crm','note',?,'logged')")
        .run(l.client_id, l.id, inst.id, `Parcela ${inst.number} renegociada: venc. ${F.formatDateBR(inst.due_date)} → ${F.formatDateBR(due)}, valor ${F.formatBRL(inst.amount_cents)} → ${F.formatBRL(amount)}${waived ? ', encargos isentos' : ''}.`);
    });
    res.json(loanWithState(getLoan(inst.loan_id)));
  });

  api.delete('/payments/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM payments WHERE id=?').get(int(req.params.id));
    if (!p) throw notFound('Pagamento');
    tx(db, () => {
      const inst = db.prepare('SELECT * FROM installments WHERE id=?').get(p.installment_id);
      db.prepare("UPDATE installments SET paid_cents=MAX(0, paid_cents - ?), status=CASE WHEN status='paid' THEN 'open' ELSE status END, penalty_cents=0, paid_at=NULL WHERE id=?")
        .run(p.amount_cents, inst.id);
      db.prepare('DELETE FROM payments WHERE id=?').run(p.id);
      refreshLoanStatus(p.loan_id);
      const l = getLoan(p.loan_id);
      db.prepare("INSERT INTO messages(client_id, loan_id, direction, channel, kind, body, status) VALUES (?,?,'note','crm','note',?,'logged')")
        .run(l.client_id, l.id, `Pagamento de ${F.formatBRL(p.amount_cents)} (parcela ${inst.number}) estornado.`);
    });
    res.json(loanWithState(getLoan(p.loan_id)));
  });

  // ---------- Cobranças ----------
  api.get('/collections', (req, res) => {
    const ref = today();
    const days = Math.min(90, Math.max(1, int(req.query.days, 7)));
    const limit = F.addDays(ref, days);
    const s = getSettings(db);
    const open = openInstallmentsWithState(ref).filter((i) => i.due_date <= limit).map((i) => {
      const last = db.prepare("SELECT created_at, kind, status FROM messages WHERE installment_id=? AND direction='out' ORDER BY id DESC LIMIT 1").get(i.id);
      return { ...i, last_message: last || null, wa_link: i.client_phone ? M.waLink(i.client_phone, '', s.default_country_code) : null };
    });
    res.json({
      today: ref,
      overdue: open.filter((i) => i.situation === 'overdue').sort((a, b) => b.days_late - a.days_late),
      due_today: open.filter((i) => i.situation === 'due_today'),
      upcoming: open.filter((i) => i.situation === 'open'),
    });
  });

  // ---------- Mensagens ----------
  api.get('/messages', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) { where.push('m.status=?'); params.push(String(req.query.status)); }
    if (req.query.direction) { where.push('m.direction=?'); params.push(String(req.query.direction)); }
    if (req.query.channel) { where.push('m.channel=?'); params.push(String(req.query.channel)); }
    const rows = db.prepare(`SELECT m.*, c.name AS client_name, c.phone AS client_phone FROM messages m LEFT JOIN clients c ON c.id=m.client_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`).all(...params, Math.min(1000, int(req.query.limit, 200)));
    const s = getSettings(db);
    res.json(rows.map((m) => ({ ...m, wa_link: m.channel === 'whatsapp' && m.client_phone ? M.waLink(m.client_phone, m.body, s.default_country_code) : null })));
  });

  api.post('/messages/:id/mark-sent', (req, res) => {
    db.prepare("UPDATE messages SET status='sent', sent_at=?, error=NULL WHERE id=?").run(new Date().toISOString(), int(req.params.id));
    res.json({ ok: true });
  });

  api.post('/messages/:id/retry', async (req, res) => {
    const m = db.prepare('SELECT * FROM messages WHERE id=?').get(int(req.params.id));
    if (!m || m.direction !== 'out' || m.channel !== 'whatsapp') throw notFound('Mensagem');
    const c = getClient(m.client_id);
    let status, error = null, providerId = null;
    try {
      const r = await M.sendWhatsApp(getSettings(db), c.phone, m.body);
      status = r.status; providerId = r.providerId || null;
    } catch (e) { status = 'failed'; error = e.message; }
    db.prepare('UPDATE messages SET status=?, error=?, provider_id=?, sent_at=? WHERE id=?')
      .run(status, error, providerId, status === 'sent' ? new Date().toISOString() : null, m.id);
    res.json(withLink(db.prepare('SELECT * FROM messages WHERE id=?').get(m.id), c));
  });

  api.delete('/messages/:id', (req, res) => {
    db.prepare('DELETE FROM messages WHERE id=?').run(int(req.params.id));
    res.json({ ok: true });
  });

  // ---------- Modelos e regras ----------
  api.get('/templates', (req, res) => res.json(db.prepare('SELECT * FROM templates ORDER BY id').all()));
  api.post('/templates', (req, res) => {
    const { name, body } = req.body || {};
    if (!name || !body) throw bad('Informe nome e texto');
    const r = db.prepare('INSERT INTO templates(name, body) VALUES (?,?)').run(String(name), String(body));
    res.status(201).json(db.prepare('SELECT * FROM templates WHERE id=?').get(Number(r.lastInsertRowid)));
  });
  api.put('/templates/:id', (req, res) => {
    const { name, body } = req.body || {};
    if (!name || !body) throw bad('Informe nome e texto');
    db.prepare('UPDATE templates SET name=?, body=? WHERE id=?').run(String(name), String(body), int(req.params.id));
    res.json(db.prepare('SELECT * FROM templates WHERE id=?').get(int(req.params.id)));
  });
  api.delete('/templates/:id', (req, res) => {
    if (db.prepare('SELECT 1 FROM rules WHERE template_id=?').get(int(req.params.id))) throw bad('Modelo em uso por uma regra de automação');
    db.prepare('DELETE FROM templates WHERE id=?').run(int(req.params.id));
    res.json({ ok: true });
  });

  function ruleInput(b) {
    if (!b.name) throw bad('Informe o nome da regra');
    if (!['before_due', 'on_due', 'after_due'].includes(b.trigger)) throw bad('Gatilho inválido');
    if (!db.prepare('SELECT 1 FROM templates WHERE id=?').get(int(b.template_id))) throw bad('Selecione um modelo');
    return [String(b.name), b.trigger, Math.max(0, int(b.days)), Math.max(0, int(b.repeat_every)), Math.max(0, int(b.max_repeats)),
      int(b.template_id), b.channel === 'crm' ? 'crm' : 'whatsapp', b.active === false || b.active === 0 ? 0 : 1];
  }
  api.get('/rules', (req, res) => res.json(db.prepare('SELECT r.*, t.name AS template_name FROM rules r JOIN templates t ON t.id=r.template_id ORDER BY r.id').all()));
  api.post('/rules', (req, res) => {
    const r = db.prepare('INSERT INTO rules(name, trigger, days, repeat_every, max_repeats, template_id, channel, active) VALUES (?,?,?,?,?,?,?,?)').run(...ruleInput(req.body || {}));
    res.status(201).json(db.prepare('SELECT * FROM rules WHERE id=?').get(Number(r.lastInsertRowid)));
  });
  api.put('/rules/:id', (req, res) => {
    db.prepare('UPDATE rules SET name=?, trigger=?, days=?, repeat_every=?, max_repeats=?, template_id=?, channel=?, active=? WHERE id=?')
      .run(...ruleInput(req.body || {}), int(req.params.id));
    res.json(db.prepare('SELECT * FROM rules WHERE id=?').get(int(req.params.id)));
  });
  api.delete('/rules/:id', (req, res) => {
    db.prepare('DELETE FROM rules WHERE id=?').run(int(req.params.id));
    res.json({ ok: true });
  });

  api.post('/automations/run', async (req, res) => {
    res.json(await runAutomations(db, { force: true, dryRun: !!req.body?.dryRun }));
  });
  api.get('/automations/status', (req, res) => res.json({ last: scheduler?.last() || null }));

  // ---------- Configurações ----------
  api.get('/settings', (req, res) => {
    const s = getSettings(db);
    delete s.password_hash;
    for (const k of SECRET_KEYS) if (s[k]) s[k] = MASK;
    res.json(s);
  });
  api.put('/settings', (req, res) => {
    const b = { ...(req.body || {}) };
    delete b.password_hash;
    for (const k of SECRET_KEYS) if (b[k] === MASK) delete b[k];
    setSettings(db, b);
    scheduler?.reschedule();
    res.json({ ok: true });
  });
  api.post('/settings/test-whatsapp', async (req, res) => {
    const phone = String(req.body?.phone || '');
    try {
      const r = await M.sendWhatsApp(getSettings(db), phone, `Teste de envio — ${getSettings(db).business_name}`);
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ---------- Relatórios ----------
  api.get('/reports', (req, res) => {
    const ref = today();
    const from = isDate(req.query.from) ? req.query.from : ref.slice(0, 8) + '01';
    const to = isDate(req.query.to) ? req.query.to : ref;
    const payments = db.prepare(`SELECT p.*, i.number, c.name AS client_name FROM payments p JOIN installments i ON i.id=p.installment_id
      JOIN loans l ON l.id=p.loan_id JOIN clients c ON c.id=l.client_id WHERE p.paid_at BETWEEN ? AND ? ORDER BY p.paid_at`).all(from, to);
    const loans = db.prepare(`SELECT l.*, c.name AS client_name FROM loans l JOIN clients c ON c.id=l.client_id
      WHERE l.start_date BETWEEN ? AND ? AND l.status!='canceled' ORDER BY l.start_date`).all(from, to);
    const dueInPeriod = db.prepare(`SELECT COALESCE(SUM(i.amount_cents),0) s, COUNT(*) c FROM installments i JOIN loans l ON l.id=i.loan_id
      WHERE i.due_date BETWEEN ? AND ? AND i.status!='canceled'`).get(from, to);
    const paidOnTime = db.prepare(`SELECT COUNT(*) c FROM installments WHERE due_date BETWEEN ? AND ? AND status='paid' AND paid_at <= due_date`).get(from, to).c;
    const byMethod = {};
    for (const p of payments) byMethod[p.method || 'outro'] = (byMethod[p.method || 'outro'] || 0) + p.amount_cents;
    res.json({
      from, to, payments, loans,
      received_cents: payments.reduce((s, p) => s + p.amount_cents, 0),
      lent_cents: loans.reduce((s, l) => s + l.principal_cents, 0),
      expected_cents: dueInPeriod.s, expected_count: dueInPeriod.c, paid_on_time: paidOnTime,
      by_method: byMethod,
    });
  });

  function csv(rows, cols) {
    const esc = (v) => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return '﻿' + [cols.map((c) => c[0]).join(';'), ...rows.map((r) => cols.map((c) => esc(c[1](r))).join(';'))].join('\n');
  }
  const money = (c) => (Number(c || 0) / 100).toFixed(2).replace('.', ',');

  api.get('/export/:type', (req, res) => {
    const ref = today();
    let out;
    switch (req.params.type) {
      case 'clientes.csv':
        out = csv(db.prepare('SELECT * FROM clients ORDER BY name').all(), [
          ['ID', (r) => r.id], ['Nome', (r) => r.name], ['Telefone', (r) => r.phone], ['Documento', (r) => r.document],
          ['E-mail', (r) => r.email], ['Endereço', (r) => r.address], ['Tags', (r) => r.tags], ['Score', (r) => r.score], ['Observações', (r) => r.notes]]);
        break;
      case 'parcelas.csv': {
        const rows = db.prepare(`SELECT i.*, l.late_fee_percent, l.late_interest_daily, l.installments_count, c.name AS client_name, l.id AS lid
          FROM installments i JOIN loans l ON l.id=i.loan_id JOIN clients c ON c.id=l.client_id ORDER BY i.due_date`).all()
          .map((r) => F.installmentState(r, r, ref));
        out = csv(rows, [['Empréstimo', (r) => r.lid], ['Cliente', (r) => r.client_name], ['Parcela', (r) => `${r.number}/${r.installments_count}`],
          ['Vencimento', (r) => F.formatDateBR(r.due_date)], ['Valor', (r) => money(r.amount_cents)], ['Pago', (r) => money(r.paid_cents)],
          ['Encargos', (r) => money(r.current_penalty_cents)], ['Restante', (r) => money(r.remaining_cents)], ['Situação', (r) => r.situation],
          ['Dias atraso', (r) => r.days_late], ['Pago em', (r) => F.formatDateBR(r.paid_at)]]);
        break;
      }
      case 'pagamentos.csv':
        out = csv(db.prepare(`SELECT p.*, i.number, c.name AS client_name FROM payments p JOIN installments i ON i.id=p.installment_id
          JOIN loans l ON l.id=p.loan_id JOIN clients c ON c.id=l.client_id ORDER BY p.paid_at`).all(), [
          ['Data', (r) => F.formatDateBR(r.paid_at)], ['Cliente', (r) => r.client_name], ['Empréstimo', (r) => r.loan_id], ['Parcela', (r) => r.number],
          ['Valor', (r) => money(r.amount_cents)], ['Forma', (r) => r.method], ['Obs', (r) => r.notes]]);
        break;
      case 'emprestimos.csv':
        out = csv(db.prepare('SELECT l.*, c.name AS client_name FROM loans l JOIN clients c ON c.id=l.client_id ORDER BY l.start_date').all().map((l) => loanWithState(l, ref)), [
          ['ID', (r) => r.id], ['Cliente', (r) => r.client_name], ['Data', (r) => F.formatDateBR(r.start_date)], ['Valor emprestado', (r) => money(r.principal_cents)],
          ['Taxa %', (r) => String(r.interest_rate).replace('.', ',')], ['Método', (r) => r.method], ['Frequência', (r) => r.frequency], ['Parcelas', (r) => r.installments_count],
          ['Total', (r) => money(r.total_cents)], ['Pago', (r) => money(r.paid_cents)], ['Saldo', (r) => money(r.balance_cents)], ['Em atraso', (r) => money(r.overdue_cents)], ['Status', (r) => r.status]]);
        break;
      default:
        throw notFound('Exportação');
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}"`);
    res.send(out);
  });

  const TABLES = ['clients', 'loans', 'installments', 'payments', 'templates', 'rules', 'messages', 'documents', 'settings'];
  api.get('/backup', (req, res) => {
    const dump = { version: 1, exported_at: new Date().toISOString() };
    for (const t of TABLES) dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
    dump.settings = dump.settings.filter((s) => s.key !== 'password_hash');
    res.setHeader('Content-Disposition', `attachment; filename="backup-emprestimos-${today()}.json"`);
    res.json(dump);
  });
  api.post('/restore', (req, res) => {
    const dump = req.body;
    if (!dump || dump.version !== 1) throw bad('Arquivo de backup inválido');
    tx(db, () => {
      db.exec('PRAGMA defer_foreign_keys = ON');
      for (const t of [...TABLES].reverse()) if (t !== 'settings') db.exec(`DELETE FROM ${t}`);
      for (const t of TABLES) {
        for (const row of dump[t] || []) {
          if (t === 'settings' && row.key === 'password_hash') continue;
          const cols = Object.keys(row);
          db.prepare(`INSERT OR REPLACE INTO ${t}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
        }
      }
    });
    res.json({ ok: true });
  });

  // ---------- Frontend ----------
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // ---------- Erros ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Erro interno: ' + err.message : err.message });
  });

  return app;
}

module.exports = { createApp };
