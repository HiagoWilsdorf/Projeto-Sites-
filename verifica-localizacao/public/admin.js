'use strict';
// Painel: login por senha, criação de links de verificação e histórico das localizações.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let APP_NAME = 'Verifica Localização';
let liveTimer = null;
function stopAutoRefresh() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 5000 : 2500);
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data;
}

const brand = (sub) => `<div class="brand"><div class="logo">📍</div><div><h1>${esc(APP_NAME)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div></div>`;

const STATUS = {
  pending: ['Aguardando', 'info'], captured: ['Confirmada', 'ok'], denied: ['Não autorizada', 'warn'], expired: ['Expirado', ''],
};
const badge = (s) => { const [t, c] = STATUS[s] || [s, '']; return `<span class="badge ${c}">${t}</span>`; };
const fmt = (d) => d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';

function loginScreen() {
  stopAutoRefresh();
  $('#app').innerHTML = `${brand('Painel de acesso')}
    <div class="card">
      <h2>Entrar</h2>
      <form id="login">
        <label>Senha de acesso</label>
        <input type="password" name="password" autocomplete="current-password" required autofocus>
        <button class="btn primary block" style="margin-top:14px">Entrar</button>
      </form>
    </div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try { await api('POST', '/api/login', { password: e.target.password.value }); start(); }
    catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  };
}

function fixedBlock(c) {
  const rows = [];
  if (c.ip_place || c.ip) rows.push(`<div class="kv"><span class="k">Por IP</span><span class="v">${esc(c.ip_place || '—')}${c.ip ? ` <span class="small muted">(${esc(c.ip)})</span>` : ''}</span></div>`);
  if (c.gps_lat != null) rows.push(`<div class="kv"><span class="k">GPS</span><span class="v">${c.gps_lat.toFixed(5)}, ${c.gps_lng.toFixed(5)}${c.gps_accuracy != null ? ` <span class="small muted">±${Math.round(c.gps_accuracy)} m</span>` : ''}</span></div>`);
  if (c.gps_address) rows.push(`<div class="kv"><span class="k">Endereço</span><span class="v">${esc(c.gps_address)}</span></div>`);
  if (!rows.length) return '';
  const map = c.maps_url ? `<a class="btn sm" href="${esc(c.maps_url)}" target="_blank" rel="noopener">Ver no mapa</a>` : '';
  return `<div class="subcard"><div class="subhead">📌 Localização fixa</div>${rows.join('')}${map ? `<div class="row" style="margin-top:8px">${map}</div>` : ''}</div>`;
}

function liveBlock(c) {
  if (!c.live_consent && c.live_lat == null) return '';
  const online = c.live_online ? '<span class="badge ok">🟢 ao vivo</span>' : (c.live_updated_at ? '<span class="badge">inativo</span>' : '<span class="badge info">aguardando</span>');
  const rows = [];
  if (c.live_lat != null) {
    rows.push(`<div class="kv"><span class="k">Posição</span><span class="v">${c.live_lat.toFixed(5)}, ${c.live_lng.toFixed(5)}${c.live_accuracy != null ? ` <span class="small muted">±${Math.round(c.live_accuracy)} m</span>` : ''}</span></div>`);
    rows.push(`<div class="kv"><span class="k">Atualizado</span><span class="v">${fmt(c.live_updated_at)}</span></div>`);
  } else {
    rows.push(`<div class="small muted">A pessoa autorizou o tempo real; aguardando ela abrir o link e compartilhar.</div>`);
  }
  const map = c.live_maps_url ? `<a class="btn sm" href="${esc(c.live_maps_url)}" target="_blank" rel="noopener">Ver no mapa</a>` : '';
  return `<div class="subcard"><div class="subhead">📡 Localização atual (tempo real) ${online}</div>${rows.join('')}${map ? `<div class="row" style="margin-top:8px">${map}</div>` : ''}</div>`;
}

function checkItem(c) {
  const actions = [];
  if (c.status === 'pending') actions.push(`<button class="btn sm" data-share="${c.id}">Link / enviar</button>`);
  actions.push(`<button class="btn sm danger" data-del="${c.id}">Excluir</button>`);
  const title = c.label ? esc(c.label) : `Verificação #${c.id}`;
  return `<div class="item">
    <div class="top"><strong>${title}</strong>${badge(c.status)}</div>
    <div class="small muted" style="margin-bottom:8px">${c.captured_at ? 'Confirmada em ' + fmt(c.captured_at) : 'Criada em ' + fmt(c.created_at)}${c.status === 'pending' ? ' · expira ' + fmt(c.expires_at) : ''}</div>
    ${fixedBlock(c)}
    ${liveBlock(c)}
    <div class="row" style="margin-top:10px">${actions.join('')}</div>
  </div>`;
}

function shareBox(r) {
  const sent = r.wa_link ? `<a class="btn wa block" href="${esc(r.wa_link)}" target="_blank" rel="noopener">Enviar pelo WhatsApp</a>` : '';
  return `<div class="note" style="margin-top:12px">
    <strong>Link gerado.</strong> Envie para a pessoa:
    <div class="linkbox"><input value="${esc(r.url)}" readonly onclick="this.select()"><button class="btn sm" data-copy="${esc(r.url)}">Copiar</button></div>
    ${sent}
  </div>`;
}

async function dashboard() {
  const list = await api('GET', '/api/checks');
  $('#app').innerHTML = `${brand('Painel')}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">Nova verificação</h2>
        <button class="btn sm" id="logout">Sair</button>
      </div>
      <form id="new">
        <label>Identificação (opcional)</label>
        <input name="label" maxlength="120" placeholder="Ex.: João — cliente, pedido #123">
        <div class="row">
          <div><label>WhatsApp (opcional)</label><input name="phone" maxlength="30" placeholder="(11) 99999-9999"></div>
          <div><label>Validade do link</label><select name="hours"><option value="24">24 horas</option><option value="2">2 horas</option><option value="48">48 horas</option><option value="168">7 dias</option></select></div>
        </div>
        <label>Mensagem/motivo mostrado à pessoa (opcional)</label>
        <textarea name="purpose" maxlength="300" placeholder="Ex.: Confirmação de endereço para liberação do pedido"></textarea>
        <button class="btn primary block" style="margin-top:14px">Gerar link</button>
      </form>
      <div id="result"></div>
    </div>
    <div class="card">
      <h2>Histórico</h2>
      <div id="list">${list.length ? list.map(checkItem).join('') : '<div class="empty">Nenhuma verificação ainda</div>'}</div>
    </div>`;

  // Atualiza o histórico periodicamente para refletir a localização ao vivo.
  stopAutoRefresh();
  liveTimer = setInterval(dashboardRefreshList, 5000);

  $('#logout').onclick = async () => { stopAutoRefresh(); await api('POST', '/api/logout'); loginScreen(); };
  $('#new').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      const f = e.target;
      const r = await api('POST', '/api/checks', { label: f.label.value, phone: f.phone.value, purpose: f.purpose.value, hours: Number(f.hours.value) });
      $('#result').innerHTML = shareBox(r);
      bindCopy($('#result'));
      f.reset();
      dashboardRefreshList();
    } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
  };
  bindActions();
}

async function dashboardRefreshList() {
  try {
    const list = await api('GET', '/api/checks');
    $('#list').innerHTML = list.length ? list.map(checkItem).join('') : '<div class="empty">Nenhuma verificação ainda</div>';
    bindActions();
  } catch { /* ignore */ }
}

function bindCopy(root) {
  for (const b of root.querySelectorAll('[data-copy]')) b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast('Link copiado'); };
}

function bindActions() {
  const root = $('#list'); if (!root) return;
  bindCopy(root);
  for (const b of root.querySelectorAll('[data-del]')) b.onclick = async () => {
    if (!confirm('Excluir esta verificação?')) return;
    try { await api('DELETE', `/api/checks/${b.dataset.del}`); dashboardRefreshList(); } catch (e) { toast(e.message, 'error'); }
  };
  for (const b of root.querySelectorAll('[data-share]')) b.onclick = async () => {
    try {
      const r = await api('GET', `/api/checks/${b.dataset.share}`);
      $('#result').innerHTML = shareBox(r);
      bindCopy($('#result'));
      $('#result').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) { toast(e.message, 'error'); }
  };
}

async function start() {
  try {
    const me = await api('GET', '/api/me');
    APP_NAME = me.app_name || APP_NAME;
    document.title = `Painel · ${APP_NAME}`;
    if (!me.configured) { $('#app').innerHTML = `${brand()}<div class="card"><div class="empty">Configure a variável <b>ADMIN_PASSWORD</b> no servidor para acessar o painel.</div></div>`; return; }
    if (me.authenticated) dashboard(); else loginScreen();
  } catch (e) { toast(e.message, 'error'); }
}

start();
