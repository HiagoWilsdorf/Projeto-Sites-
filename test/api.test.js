'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../server/db');
const { createApp } = require('../server/app');
const { runAutomations } = require('../server/scheduler');
const F = require('../server/finance');

async function setup() {
  const db = open(':memory:');
  const app = createApp(db);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { db, server, call };
}

test('fluxo completo: cliente, empréstimo, pagamento, automação', async () => {
  const { db, server, call } = await setup();
  try {
    assert.strictEqual((await call('GET', '/api/dashboard')).status, 401);
    assert.strictEqual((await call('POST', '/api/auth/setup', { password: 'segredo123' })).status, 200);

    const c = (await call('POST', '/api/clients', { name: 'Maria Souza', phone: '(11) 98888-7777' })).data;
    assert.ok(c.id);

    const today = F.todayIn('America/Sao_Paulo');
    // empréstimo começado há 2 meses, 3 parcelas mensais → 1ª já vencida
    const start = F.addMonths(today, -2);
    const loanRes = await call('POST', '/api/loans', {
      client_id: c.id, principal_cents: 100000, interest_rate: 10, method: 'simple', frequency: 'monthly',
      installments_count: 3, start_date: start, first_due_date: F.addDays(F.addMonths(start, 1), 0),
    });
    assert.strictEqual(loanRes.status, 201);
    const loan = loanRes.data;
    assert.strictEqual(loan.total_cents, 130000);
    assert.ok(loan.overdue_count >= 1);

    const dash = (await call('GET', '/api/dashboard')).data;
    assert.ok(dash.totals.overdue > 0);

    // Automação (modo manual → fica pendente de envio manual)
    const run = await runAutomations(db, { force: true });
    assert.ok(run.created >= 1, 'deve gerar mensagem de atraso');
    const again = await runAutomations(db, { force: true });
    assert.strictEqual(again.created, 0, 'não deve duplicar mensagens');
    const pend = (await call('GET', '/api/messages?status=pending_manual')).data;
    assert.ok(pend.length >= 1 && pend[0].wa_link.startsWith('https://wa.me/5511988887777'));

    // Paga a 1ª parcela integralmente (com encargos)
    const inst1 = loan.installments[0];
    const payRes = await call('POST', `/api/installments/${inst1.id}/pay`, { amount_cents: inst1.remaining_cents, paid_at: today, carry_over: false });
    assert.strictEqual(payRes.status, 200, JSON.stringify(payRes.data));
    assert.strictEqual(payRes.data.applied[0].settled, true);

    // Paga o restante de uma vez (transborda para as demais parcelas)
    const l2 = (await call('GET', `/api/loans/${loan.id}`)).data;
    const pay2 = await call('POST', `/api/installments/${l2.installments[1].id}/pay`, { amount_cents: l2.balance_cents + 500 });
    assert.strictEqual(pay2.data.leftover_cents, 500);
    assert.strictEqual(pay2.data.loan.status, 'paid');

    // Estorno reabre o empréstimo
    const pid = (await call('GET', `/api/loans/${loan.id}`)).data.payments[0].id;
    const und = await call('DELETE', `/api/payments/${pid}`);
    assert.strictEqual(und.data.status, 'active');

    // CSV
    const exp = await call('GET', '/api/export/parcelas.csv');
    assert.ok(String(exp.data).includes('Maria Souza'));

    // Webhook de entrada
    const tok = db.prepare("SELECT value FROM settings WHERE key='wa_inbound_token'").get().value;
    const wh = await call('POST', `/api/webhooks/whatsapp/${tok}`, { data: { key: { remoteJid: '5511988887777@s.whatsapp.net', fromMe: false, id: 'X1' }, message: { conversation: 'Já paguei!' } } });
    assert.strictEqual(wh.status, 200);
    const detail = (await call('GET', `/api/clients/${c.id}`)).data;
    assert.ok(detail.messages.some((m) => m.direction === 'in' && m.body === 'Já paguei!'));
    assert.strictEqual((await call('POST', '/api/webhooks/whatsapp/errado', {})).status, 403);
  } finally {
    server.close();
  }
});

test('pedido pelo WhatsApp: novo contato, bot, documentos, liberação com confirmação', async () => {
  const { db, server, call } = await setup();
  // provedor "webhook" apontando para um servidor de teste que captura os envios
  const sent = [];
  const http = require('node:http');
  const sink = await new Promise((r) => {
    const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { sent.push(JSON.parse(b)); res.end('{"id":1}'); }); });
    s.listen(0, () => r(s));
  });
  try {
    await call('POST', '/api/auth/setup', { password: 'segredo123' });
    await call('PUT', '/api/settings', { wa_provider: 'webhook', wa_webhook_url: `http://127.0.0.1:${sink.address().port}/`, bot_enabled: '1', pix_key: 'chave-pix' });
    const tok = db.prepare("SELECT value FROM settings WHERE key='wa_inbound_token'").get().value;

    // 1) Pessoa desconhecida chama no WhatsApp → vira "novo contato" e recebe a lista de documentos
    await call('POST', `/api/webhooks/whatsapp/${tok}`, { data: { key: { remoteJid: '5511977776666@s.whatsapp.net', fromMe: false, id: 'A1' }, pushName: 'Carlos Lima', message: { conversation: 'Oi, quero um empréstimo de 1000' } } });
    const pipe = (await call('GET', '/api/pipeline')).data;
    assert.strictEqual(pipe.lead.length, 1);
    assert.strictEqual(pipe.lead[0].name, 'Carlos Lima');
    assert.ok(sent[0].message.includes('Comprovante de residência'));
    const id = pipe.lead[0].id;

    // Mensagens de grupo são ignoradas
    await call('POST', `/api/webhooks/whatsapp/${tok}`, { data: { key: { remoteJid: '123-456@g.us', fromMe: false, id: 'G1' }, message: { conversation: 'oi' } } });
    assert.strictEqual((await call('GET', '/api/pipeline')).data.lead.length, 1);

    // 2) Análise: documentos e checklist
    await call('POST', `/api/clients/${id}/stage`, { stage: 'analysis' });
    const doc = await call('POST', `/api/clients/${id}/documents`, { name: 'CPF', filename: 'cpf.png', mime: 'image/png', data: Buffer.from('fake').toString('base64') });
    assert.strictEqual(doc.status, 201);
    const det = (await call('GET', `/api/clients/${id}`)).data;
    assert.strictEqual(det.doc_checklist.CPF, true);
    assert.strictEqual(det.documents.length, 1);
    assert.strictEqual((await call('GET', `/api/documents/${doc.data.id}`)).data, 'fake');
    await call('POST', `/api/clients/${id}/stage`, { stage: 'approved' });

    // 3) Liberação: vira cliente e recebe confirmação com as datas
    const loan = (await call('POST', '/api/loans', { client_id: id, principal_cents: 100000, interest_rate: 10, method: 'simple', frequency: 'monthly', installments_count: 2 })).data;
    assert.strictEqual(loan.confirmation.status, 'sent');
    assert.ok(loan.confirmation.body.includes('1/2 –') && loan.confirmation.body.includes('2/2 –'));
    assert.strictEqual((await call('GET', `/api/clients/${id}`)).data.stage, 'client');

    // 4) Bot para cliente ativo
    const n = sent.length;
    await call('POST', `/api/webhooks/whatsapp/${tok}`, { data: { key: { remoteJid: '5511977776666@s.whatsapp.net', fromMe: false, id: 'A2' }, message: { conversation: '1' } } });
    assert.ok(sent[n].message.includes('próxima parcela') && sent[n].message.includes('R$'));
    await call('POST', `/api/webhooks/whatsapp/${tok}`, { data: { key: { remoteJid: '5511977776666@s.whatsapp.net', fromMe: false, id: 'A3' }, message: { conversation: 'qual o pix?' } } });
    assert.ok(sent[n + 1].message.includes('chave-pix'));
  } finally {
    server.close(); sink.close();
  }
});
