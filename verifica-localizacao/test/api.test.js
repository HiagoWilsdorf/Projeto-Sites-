'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');
const { createStore } = require('../src/store');

process.env.ADMIN_PASSWORD = 'senha-de-teste';
process.env.SESSION_SECRET = 'segredo-de-teste';

async function setup() {
  const app = createApp({ store: createStore({ memory: true }) });
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
  return { server, call, close: async () => { server.close(); } };
}

test('login, criação de link e captura só com consentimento', async () => {
  const t = await setup();
  try {
    assert.strictEqual((await t.call('GET', '/api/checks')).status, 401);
    assert.strictEqual((await t.call('POST', '/api/login', { password: 'errada' })).status, 401);
    assert.strictEqual((await t.call('POST', '/api/login', { password: 'senha-de-teste' })).status, 200);

    const gen = await t.call('POST', '/api/checks', { label: 'João', phone: '11988887777', purpose: 'Confirmar endereço', hours: 24 });
    assert.strictEqual(gen.status, 201, JSON.stringify(gen.data));
    assert.match(gen.data.url, /\/v\/[a-f0-9]+$/);
    assert.ok(gen.data.wa_link.includes('wa.me/5511988887777'));
    const token = gen.data.url.split('/v/')[1];

    const v = await t.call('GET', `/api/v/${token}`);
    assert.strictEqual(v.data.status, 'pending');
    assert.strictEqual(v.data.done, false);
    assert.strictEqual(v.data.purpose, 'Confirmar endereço');

    assert.strictEqual((await t.call('POST', `/api/v/${token}`, { consent: false })).data.status, 'denied');
    assert.strictEqual((await t.call('POST', `/api/v/${token}`, { consent: true })).status, 400);

    // Confirmação com consentimento de tempo real + atualizações ao vivo
    const gen2 = await t.call('POST', '/api/checks', {});
    const token2 = gen2.data.url.split('/v/')[1];
    const conf = await t.call('POST', `/api/v/${token2}`, { consent: true, live_consent: true, gps: { lat: -23.5, lng: -46.6, accuracy: 10 } });
    assert.strictEqual(conf.data.status, 'captured');
    assert.strictEqual(conf.data.live, true);
    // envia posição ao vivo
    assert.strictEqual((await t.call('POST', `/api/v/${token2}/live`, { gps: { lat: -23.56, lng: -46.64, accuracy: 8 } })).status, 200);
    const det = (await t.call('GET', '/api/checks')).data.find((x) => x.token === token2);
    assert.strictEqual(det.live_consent, true);
    assert.strictEqual(det.live_lat, -23.56);
    assert.strictEqual(det.live_online, true);
    assert.ok(det.live_maps_url.includes('-23.56,-46.64'));
    // sem consentimento de tempo real, o endpoint ao vivo é bloqueado
    const gen3 = await t.call('POST', '/api/checks', {});
    const token3 = gen3.data.url.split('/v/')[1];
    await t.call('POST', `/api/v/${token3}`, { consent: true, live_consent: false });
    assert.strictEqual((await t.call('POST', `/api/v/${token3}/live`, { gps: { lat: 1, lng: 2 } })).status, 403);

    const list = (await t.call('GET', '/api/checks')).data;
    assert.strictEqual(list.length, 3);
    assert.ok(list.some((x) => x.status === 'denied'));

    assert.strictEqual((await t.call('GET', '/api/v/naoexiste')).status, 404);

    assert.strictEqual((await t.call('DELETE', `/api/checks/${list[0].id}`)).status, 200);
    assert.strictEqual((await t.call('GET', '/api/checks')).data.length, 2);

    await t.call('POST', '/api/logout');
    assert.strictEqual((await t.call('GET', '/api/checks')).status, 401);
  } finally {
    await t.close();
  }
});
