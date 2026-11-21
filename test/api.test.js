'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { connect } = require('../src/db');
const { createApp } = require('../src/app');
const { createStorage } = require('../src/storage');
const { runAutomations } = require('../src/scheduler');
const F = require('../src/finance');

async function setup() {
  const db = await connect({ url: '', dir: '' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emp-'));
  const app = createApp({ db, storage: createStorage({ dir }) });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Cada "navegador" tem seu próprio cookie.
  const browser = () => {
    let cookie = '';
    let account = '';
    const call = async (method, url, body, headers = {}) => {
      const isBuf = Buffer.isBuffer(body);
      const res = await fetch(base + url, {
        method,
        headers: { ...(isBuf ? {} : { 'Content-Type': 'application/json' }), cookie, ...(account ? { 'x-account': account } : {}), ...headers },
        body: body == null ? undefined : isBuf ? body : JSON.stringify(body),
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
      return { status: res.status, data };
    };
    call.setAccount = (id) => { account = id ? String(id) : ''; };
    return call;
  };
  return { db, server, browser, close: async () => { server.close(); await db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function sink() {
  const sent = [];
  return new Promise((r) => {
    const s = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { sent.push(JSON.parse(b || '{}')); res.setHeader('Content-Type', 'application/json'); res.end('{"id":1}'); });
    });
    s.listen(0, () => r({ sent, url: `http://127.0.0.1:${s.address().port}/`, close: () => s.close() }));
  });
}

test('conta central x afiliados: cada um vê só o seu, a central vê tudo', async () => {
  const t = await setup();
  try {
    const admin = t.browser();
    assert.strictEqual((await admin('GET', '/api/dashboard')).status, 401);
    const st = await admin('POST', '/api/auth/setup', { name: 'Central', email: 'central@x.com', password: 'segredo1' });
    assert.strictEqual(st.status, 200);
    assert.strictEqual((await admin('POST', '/api/auth/setup', { name: 'Outro', email: 'o@x.com', password: 'segredo1' })).status, 400);

    const aff = (await admin('POST', '/api/accounts', { name: 'Afiliado João', email: 'joao@x.com', password: 'senha123' })).data;
    const aff2 = (await admin('POST', '/api/accounts', { name: 'Afiliada Ana', email: 'ana@x.com', password: 'senha123' })).data;

    const joao = t.browser();
    assert.strictEqual((await joao('POST', '/api/auth/login', { email: 'joao@x.com', password: 'errada' })).status, 401);
    assert.strictEqual((await joao('POST', '/api/auth/login', { email: 'JOAO@x.com', password: 'senha123' })).status, 200);
    const ana = t.browser();
    await ana('POST', '/api/auth/login', { email: 'ana@x.com', password: 'senha123' });

    // Afiliado cadastra cliente + empréstimo
    const today = F.todayIn('America/Sao_Paulo');
    const start = F.addMonths(today, -2);
    const l1 = await joao('POST', '/api/loans', {
      new_client: { name: 'Maria Souza', phone: '(11) 98888-7777' }, owner_id: aff2.id, // owner_id é ignorado para afiliado
      principal_cents: 100000, interest_rate: 10, method: 'simple', frequency: 'monthly', installments_count: 3, start_date: start,
    });
    assert.strictEqual(l1.status, 201, JSON.stringify(l1.data));
    assert.strictEqual(l1.data.owner_id, aff.id);
    assert.strictEqual(l1.data.confirmation.status, 'pending_manual');
    assert.ok(l1.data.confirmation.body.includes('1/3 –'));
    const l2 = await ana('POST', '/api/loans', { new_client: { name: 'Pedro', phone: '21999990000' }, principal_cents: 50000, interest_rate: 5, method: 'price', frequency: 'weekly', installments_count: 4 });
    assert.strictEqual(l2.status, 201);

    // Isolamento
    assert.strictEqual((await joao('GET', '/api/clients')).data.length, 1);
    assert.strictEqual((await joao('GET', `/api/loans/${l2.data.id}`)).status, 404);
    assert.strictEqual((await joao('GET', `/api/clients/${l2.data.client_id}`)).status, 404);
    assert.strictEqual((await joao('GET', '/api/accounts')).status, 403);
    assert.strictEqual((await joao('PUT', '/api/settings', { system_name: 'x' })).status, 403);
    assert.ok((await joao('GET', '/api/dashboard')).data.totals.overdue > 0);
    assert.strictEqual((await ana('GET', '/api/dashboard')).data.totals.overdue, 0);

    // Central vê tudo e pode focar em uma conta
    assert.strictEqual((await admin('GET', '/api/clients')).data.length, 2);
    admin.setAccount(aff2.id);
    const onlyAna = (await admin('GET', '/api/clients')).data;
    assert.deepStrictEqual(onlyAna.map((c) => c.name), ['Pedro']);
    admin.setAccount(null);
    const accounts = (await admin('GET', '/api/accounts')).data;
    assert.strictEqual(accounts.length, 3);
    assert.ok(accounts.find((a) => a.id === aff.id).overdue_cents > 0);
    assert.strictEqual((await admin('GET', `/api/loans/${l1.data.id}`)).status, 200);

    // Pagamento pela central na conta do afiliado
    const inst = l1.data.installments[0];
    const pay = await admin('POST', `/api/installments/${inst.id}/pay`, { amount_cents: inst.remaining_cents, carry_over: false, send_receipt: false });
    assert.strictEqual(pay.status, 200, JSON.stringify(pay.data));
    assert.strictEqual(pay.data.applied[0].settled, true);

    // Automações geram cobranças por conta, sem duplicar
    const r1 = await runAutomations(t.db, { force: true });
    assert.ok(r1.created >= 1);
    assert.strictEqual((await runAutomations(t.db, { force: true })).created, 0);
    const msgsJoao = (await joao('GET', '/api/messages?status=pending_manual')).data;
    assert.ok(msgsJoao.length >= 1 && msgsJoao.every((m) => m.owner_id === aff.id));
    assert.ok(msgsJoao[0].wa_link.startsWith('https://wa.me/55'));

    // Afiliado desativado não entra
    await admin('PUT', `/api/accounts/${aff2.id}`, { active: false });
    assert.strictEqual((await ana('GET', '/api/dashboard')).status, 401);
    assert.strictEqual((await t.browser()('POST', '/api/auth/login', { email: 'ana@x.com', password: 'senha123' })).status, 403);

    // Segundo administrador (suporte) com acesso total
    const sup = await admin('POST', '/api/accounts', { name: 'Suporte', email: 'suporte@x.com', password: 'suporte1', role: 'admin' });
    assert.strictEqual(sup.status, 201);
    assert.strictEqual(sup.data.role, 'admin');
    const suporte = t.browser();
    await suporte('POST', '/api/auth/login', { email: 'suporte@x.com', password: 'suporte1' });
    assert.strictEqual((await suporte('GET', '/api/accounts')).status, 200);
    assert.strictEqual((await suporte('GET', `/api/loans/${l1.data.id}`)).status, 200);
    // Afiliado não consegue se promover; sempre resta um administrador ativo
    assert.strictEqual((await joao('POST', '/api/accounts', { name: 'X', email: 'x@x.com', password: 'xxxxxx', role: 'admin' })).status, 403);
    await suporte('PUT', `/api/accounts/${st.data.user.id}`, { active: false });
    assert.strictEqual((await suporte('PUT', `/api/accounts/${sup.data.id}`, { role: 'affiliate' })).status, 200); // não altera o próprio papel
    assert.strictEqual((await suporte('GET', '/api/me')).data.user.role, 'admin');
    await suporte('PUT', `/api/accounts/${st.data.user.id}`, { active: true });

    // CSV respeita o escopo
    const csv = (await joao('GET', '/api/export/clientes.csv')).data;
    assert.ok(csv.includes('Maria Souza') && !csv.includes('Pedro'));
  } finally { await t.close(); }
});

test('WhatsApp → link de cadastro → envio de documentos → aprovação no site', async () => {
  const t = await setup();
  const wa = await sink();
  try {
    const admin = t.browser();
    await admin('POST', '/api/auth/setup', { name: 'Central', email: 'central@x.com', password: 'segredo1' });
    const aff = (await admin('POST', '/api/accounts', { name: 'Afiliado', email: 'af@x.com', password: 'senha123' })).data;
    const af = t.browser();
    await af('POST', '/api/auth/login', { email: 'af@x.com', password: 'senha123' });
    await af('PUT', '/api/account-settings', { wa_provider: 'webhook', wa_webhook_url: wa.url, pix_key: 'pix-afiliado', business_name: 'Crédito do Afiliado' });
    const acc = (await af('GET', '/api/account-settings')).data;
    const hook = new URL(acc.webhook_url).pathname;

    // 1) Pessoa nova manda mensagem no WhatsApp do afiliado → recebe link de cadastro
    const anon = t.browser();
    await anon('POST', hook, { data: { key: { remoteJid: '5511977776666@s.whatsapp.net', fromMe: false, id: 'A1' }, pushName: 'Carlos', message: { conversation: 'Oi, quero um empréstimo' } } });
    assert.strictEqual(wa.sent.length, 1);
    assert.ok(wa.sent[0].message.includes('Crédito do Afiliado'));
    const link = wa.sent[0].message.match(/cadastro\.html\?t=([a-f0-9]+)/);
    assert.ok(link, wa.sent[0].message);
    const token = link[1];
    // grupo é ignorado
    await anon('POST', hook, { data: { key: { remoteJid: '1203-99@g.us', fromMe: false, id: 'G1' }, message: { conversation: 'oi' } } });
    assert.strictEqual(wa.sent.length, 1);
    // outra conta não vê o cadastro
    assert.strictEqual((await admin('GET', '/api/applications')).data.length, 1);
    admin.setAccount((await admin('GET', '/api/me')).data.user.id);
    assert.strictEqual((await admin('GET', '/api/applications')).data.length, 0);
    admin.setAccount(null);

    // 2) Cliente preenche o cadastro e envia os documentos pelo link
    const view = (await anon('GET', `/api/public/apply/${token}`)).data;
    assert.strictEqual(view.upload_mode, 'local');
    assert.strictEqual(view.data.phone, '5511977776666');
    assert.ok(view.document_types.length >= 5);
    await anon('PUT', `/api/public/apply/${token}`, { name: 'Carlos Lima', phone: '5511977776666', document: '123.456.789-00', requested_cents: 150000 });
    const early = await anon('POST', `/api/public/apply/${token}/submit`);
    assert.strictEqual(early.status, 400);
    assert.ok(early.data.error.includes('Falta enviar'));
    const uploaded = [];
    for (const dt of view.document_types) {
      const ct = dt.kind === 'video' ? 'video/mp4' : dt.kind === 'file' ? 'application/pdf' : 'image/jpeg';
      const r = await anon('PUT', `/api/public/apply/${token}/upload-local?type=${dt.id}&name=x.${ct.split('/')[1]}`, Buffer.from(`conteudo-${dt.id}`), { 'Content-Type': ct });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      uploaded.push(r.data);
    }
    // formato errado é recusado
    const badType = await anon('PUT', `/api/public/apply/${token}/upload-local?type=${view.document_types[0].id}&name=a.exe`, Buffer.from('x'), { 'Content-Type': 'application/x-msdownload' });
    assert.strictEqual(badType.status, 400);
    const sub = await anon('POST', `/api/public/apply/${token}/submit`);
    assert.strictEqual(sub.status, 200, JSON.stringify(sub.data));
    assert.strictEqual(sub.data.status, 'submitted');
    assert.strictEqual((await anon('PUT', `/api/public/apply/${token}`, { name: 'x' })).status, 400);

    // Mensagem durante a análise → bot avisa que está em análise
    await anon('POST', hook, { data: { key: { remoteJid: '5511977776666@s.whatsapp.net', fromMe: false, id: 'A2' }, message: { conversation: 'e aí?' } } });
    assert.ok(wa.sent[1].message.includes('análise'));

    // 3) Afiliado analisa: recusa um documento e pede correção
    const list = (await af('GET', '/api/applications?status=submitted')).data;
    assert.strictEqual(list.length, 1);
    const appId = list[0].id;
    const det = (await af('GET', `/api/applications/${appId}`)).data;
    assert.strictEqual(det.files.length, view.document_types.length);
    const file = await af('GET', `/api/files/${det.files[0].id}`);
    assert.strictEqual(file.data, `conteudo-${view.document_types[0].id}`);
    assert.strictEqual((await t.browser()('GET', `/api/files/${det.files[0].id}`)).status, 401);
    assert.strictEqual((await af('PUT', `/api/application-files/${det.files[0].id}`, { status: 'rejected' })).status, 400);
    await af('PUT', `/api/application-files/${det.files[0].id}`, { status: 'rejected', reason: 'Foto borrada' });
    const ch = await af('POST', `/api/applications/${appId}/request-changes`, {});
    assert.strictEqual(ch.status, 200);
    assert.ok(wa.sent[2].message.includes('Foto borrada') && wa.sent[2].message.includes(token));

    // Cliente reenvia o documento recusado
    const v2 = (await anon('GET', `/api/public/apply/${token}`)).data;
    assert.strictEqual(v2.status, 'needs_changes');
    assert.ok(v2.review_notes.includes('Foto borrada'));
    await anon('PUT', `/api/public/apply/${token}/upload-local?type=${view.document_types[0].id}&name=n.jpg`, Buffer.from('nova'), { 'Content-Type': 'image/jpeg' });
    assert.strictEqual((await anon('POST', `/api/public/apply/${token}/submit`)).data.status, 'submitted');

    // 4) Aprova todos os documentos e o cadastro → vira cliente do afiliado
    const det2 = (await af('GET', `/api/applications/${appId}`)).data;
    assert.strictEqual((await af('POST', `/api/applications/${appId}/approve`, {})).status, 400); // ainda há pendentes
    for (const f of det2.files.filter((x) => x.status === 'pending')) await af('PUT', `/api/application-files/${f.id}`, { status: 'approved' });
    const ap = await af('POST', `/api/applications/${appId}/approve`, {});
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.data));
    const client = (await af('GET', `/api/clients/${ap.data.client_id}`)).data;
    assert.strictEqual(client.name, 'Carlos Lima');
    assert.strictEqual(client.owner_id, aff.id);
    assert.ok(client.files.length >= view.document_types.length);
    assert.ok(wa.sent[3].message.includes('aprovado'));

    // 5) Agora é cliente: bot responde o menu
    const loan = await af('POST', '/api/loans', { client_id: client.id, principal_cents: 150000, interest_rate: 10, method: 'simple', frequency: 'monthly', installments_count: 3 });
    assert.strictEqual(loan.data.confirmation.status, 'sent');
    await anon('POST', hook, { data: { key: { remoteJid: '5511977776666@s.whatsapp.net', fromMe: false, id: 'A3' }, message: { conversation: '1' } } });
    assert.ok(wa.sent.at(-1).message.includes('próxima parcela'));

    // Link geral da conta (para divulgar)
    const slug = new URL(acc.signup_url).searchParams.get('c');
    assert.strictEqual((await anon('GET', `/api/public/signup/${slug}`)).data.business_name, 'Crédito do Afiliado');
    const s2 = await anon('POST', `/api/public/signup/${slug}`, { name: 'Bia', phone: '(31) 98888-1111' });
    assert.strictEqual(s2.status, 201);
    assert.strictEqual((await af('GET', '/api/applications?status=pending')).data.length, 1);

    // token errado no webhook
    assert.strictEqual((await anon('POST', '/api/webhooks/whatsapp/errado', {})).status, 403);
  } finally { wa.close(); await t.close(); }
});

test('cron da Vercel exige o segredo', async () => {
  const t = await setup();
  try {
    const b = t.browser();
    process.env.CRON_SECRET = 'abc';
    assert.strictEqual((await b('GET', '/api/cron/automations')).status, 401);
    const ok = await b('GET', '/api/cron/automations', null, { Authorization: 'Bearer abc' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.created, 0);
  } finally { delete process.env.CRON_SECRET; await t.close(); }
});

test('backup diário criptografado: gera, copia documentos e restaura tudo', async () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-'));
  const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  process.env.BACKUP_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');
  process.env.CRON_SECRET = 'segredo-cron';
  const backup = require('../src/backup');
  const db = await connect({ url: '', dir: '' });
  const app = createApp({ db, storage: createStorage({ dir: docsDir }), backupDir });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + url, { method, headers: { ...(isBuf ? {} : { 'Content-Type': 'application/json' }), cookie, ...headers }, body: body == null ? undefined : isBuf ? body : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  try {
    await call('POST', '/api/auth/setup', { name: 'Central', email: 'c@x.com', password: 'segredo1' });
    await call('POST', '/api/loans', { new_client: { name: 'Maria', phone: '11988887777', document: '111' }, principal_cents: 100000, interest_rate: 10, method: 'simple', frequency: 'monthly', installments_count: 3 });
    const link = (await call('POST', '/api/applications', { phone: '11977776666', name: 'Ana' })).data.link;
    const token = new URL(link).searchParams.get('t');
    const types = (await call('GET', `/api/public/apply/${token}`)).data.document_types;
    await call('PUT', `/api/public/apply/${token}/upload-local?type=${types[0].id}&name=a.jpg`, Buffer.from('foto-rg'), { 'Content-Type': 'image/jpeg' });

    // Cron protegido
    assert.strictEqual((await call('GET', '/api/cron/backup')).status, 401);
    const run = await call('GET', '/api/cron/backup', null, { Authorization: 'Bearer segredo-cron' });
    assert.strictEqual(run.status, 200, JSON.stringify(run.data));
    assert.strictEqual(run.data.encrypted, true);
    assert.strictEqual(run.data.files_copied, 1);
    assert.strictEqual(run.data.counts.clients, 1);
    // Segunda execução não copia o mesmo documento de novo
    assert.strictEqual((await call('POST', '/api/backups/run')).data.files_copied, 0);

    // O arquivo está criptografado (não contém o nome do cliente em texto)
    const list = (await call('GET', '/api/backups')).data;
    assert.ok(list.list.length >= 2 && list.last.ok);
    const raw = fs.readFileSync(path.join(backupDir, list.list[0].pathname));
    assert.ok(!raw.includes(Buffer.from('Maria')));
    assert.ok(fs.existsSync(path.join(backupDir, 'files')));
    const json = await call('GET', `/api/backups/download?pathname=${encodeURIComponent(list.list[0].pathname)}&format=json`);
    assert.strictEqual(json.data.tables.clients[0].name, 'Maria');

    // Desastre: apaga dados e restaura do backup
    const snapshot = backup.open(raw);
    await db.query('DELETE FROM payments'); await db.query('DELETE FROM loans'); await db.query('DELETE FROM messages'); await db.query('DELETE FROM clients');
    assert.strictEqual(await db.val('SELECT COUNT(*)::int FROM clients'), 0);
    await backup.restore(db, snapshot);
    assert.strictEqual(await db.val('SELECT COUNT(*)::int FROM clients'), 1);
    assert.strictEqual(await db.val('SELECT COUNT(*)::int FROM installments'), 3);
    assert.strictEqual(await db.val('SELECT COUNT(*)::int FROM users'), 1);
    // depois de restaurar, o sistema continua funcionando (login e novos registros)
    const again = await call('POST', '/api/auth/login', { email: 'c@x.com', password: 'segredo1' });
    assert.strictEqual(again.status, 200);
    const l2 = await call('POST', '/api/loans', { new_client: { name: 'Novo', phone: '11900000000' }, principal_cents: 5000, interest_rate: 1, method: 'simple', frequency: 'monthly', installments_count: 1 });
    assert.strictEqual(l2.status, 201, JSON.stringify(l2.data));

    // Chave errada não abre o backup
    process.env.BACKUP_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');
    assert.throws(() => backup.open(raw));
  } finally {
    delete process.env.BACKUP_ENCRYPTION_KEY; delete process.env.CRON_SECRET;
    server.close(); await db.close();
  }
});
