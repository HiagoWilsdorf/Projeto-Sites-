'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { connect } = require('../src/db');
const { createApp } = require('../src/app');

process.env.ADMIN_PASSWORD = 'senha-de-teste';
process.env.SESSION_SECRET = 'segredo-de-teste';

async function setup() {
  const db = await connect({ url: '', dir: '' }); // PGlite em memória
  const app = createApp({ db });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { db, server, call, close: async () => { server.close(); await db.close(); } };
}

test('login, criação de link e captura só com consentimento', async () => {
  const t = await setup();
  try {
    // Exige login
    assert.strictEqual((await t.call('GET', '/api/checks')).status, 401);
    assert.strictEqual((await t.call('POST', '/api/login', { password: 'errada' })).status, 401);
    assert.strictEqual((await t.call('POST', '/api/login', { password: 'senha-de-teste' })).status, 200);

    // Cria verificação
    const gen = await t.call('POST', '/api/checks', { label: 'João', phone: '11988887777', purpose: 'Confirmar endereço', hours: 24 });
    assert.strictEqual(gen.status, 201, JSON.stringify(gen.data));
    assert.match(gen.data.url, /\/v\/[a-f0-9]+$/);
    assert.ok(gen.data.wa_link.includes('wa.me/5511988887777'));
    const token = gen.data.url.split('/v/')[1];

    // Página pública pendente
    const view = await t.call('GET', `/api/v/${token}`);
    assert.strictEqual(view.data.status, 'pending');
    assert.strictEqual(view.data.done, false);
    assert.strictEqual(view.data.purpose, 'Confirmar endereço');

    // Sem consentimento → negado, nada capturado
    assert.strictEqual((await t.call('POST', `/api/v/${token}`, { consent: false })).data.status, 'denied');
    // Reuso bloqueado
    assert.strictEqual((await t.call('POST', `/api/v/${token}`, { consent: true })).status, 400);

    // Nova verificação, com consentimento (IP local não geolocaliza; sem GPS para não acessar a rede)
    const gen2 = await t.call('POST', '/api/checks', {});
    const token2 = gen2.data.url.split('/v/')[1];
    assert.strictEqual((await t.call('POST', `/api/v/${token2}`, { consent: true })).data.status, 'captured');

    // Histórico
    const list = (await t.call('GET', '/api/checks')).data;
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].status, 'captured');
    assert.strictEqual(list[1].status, 'denied');

    // Token inexistente
    assert.strictEqual((await t.call('GET', '/api/v/naoexiste')).status, 404);

    // Exclusão
    assert.strictEqual((await t.call('DELETE', `/api/checks/${list[0].id}`)).status, 200);
    assert.strictEqual((await t.call('GET', '/api/checks')).data.length, 1);

    // Logout derruba o acesso
    await t.call('POST', '/api/logout');
    assert.strictEqual((await t.call('GET', '/api/checks')).status, 401);
  } finally {
    await t.close();
  }
});
