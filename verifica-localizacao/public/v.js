'use strict';
// Página pública: pede consentimento (localização fixa + tempo real), captura o ponto fixo e,
// se autorizado, compartilha a localização ao vivo enquanto a tela estiver aberta.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = decodeURIComponent((location.pathname.match(/\/v\/([^/?#]+)/) || [])[1] || new URLSearchParams(location.search).get('t') || '');

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

const brand = (name, sub) => `<div class="brand"><div class="logo">📍</div><div><h1>${esc(name || 'Confirmação de localização')}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div></div>`;

const DONE = {
  captured: ['✅', 'Localização já confirmada', 'Este link já foi utilizado. Obrigado!'],
  denied: ['Tudo bem', 'Nada foi registrado', 'Você não autorizou o registro da localização. Pode fechar esta página.'],
  expired: ['⏳', 'Link expirado', 'Este link de confirmação expirou. Peça um novo.'],
};
function done(app, name, status) {
  const [icon, title, sub] = DONE[status] || DONE.captured;
  app.innerHTML = `${brand(name)}<div class="card center"><div class="big">${icon}</div><h2 style="margin:10px 0">${esc(title)}</h2><p class="muted">${esc(sub)}</p></div>`;
}

// ---------- Compartilhamento em tempo real ----------
let watchId = null;
let lastSent = 0;
const SEND_EVERY = 5000; // envia no máximo a cada 5s

function stopLive(silent) {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  try { navigator.sendBeacon?.(`/api/v/${encodeURIComponent(token)}/live/stop`); } catch { /* ok */ }
  if (!silent) {
    const el = $('#live-card');
    if (el) el.innerHTML = `<div class="center"><div class="big">⏹️</div><h2 style="margin:8px 0">Compartilhamento encerrado</h2><p class="muted">Você parou de compartilhar sua localização. Pode fechar a página.</p></div>`;
  }
}

function startLive(app, info) {
  app.innerHTML = `${brand(info.app_name)}
    <div class="card" id="live-card">
      <div class="center"><div class="big">📡</div><h2 style="margin:8px 0">Compartilhando sua localização ao vivo</h2></div>
      <p class="muted small center" id="live-status">Ativando o GPS…</p>
      <div class="note" style="margin-top:8px">Sua localização está sendo compartilhada em tempo real <strong>apenas enquanto esta tela ficar aberta</strong>. Você pode parar quando quiser.</div>
      <button class="btn danger block" id="stop" style="margin-top:14px">Parar compartilhamento</button>
    </div>`;
  $('#stop').onclick = () => stopLive(false);

  if (!navigator.geolocation) { $('#live-status').textContent = 'Seu navegador não suporta localização.'; return; }
  watchId = navigator.geolocation.watchPosition(async (p) => {
    const now = Date.now();
    if (now - lastSent < SEND_EVERY) return; // controla a frequência de envio
    lastSent = now;
    try {
      await api('POST', `/api/v/${encodeURIComponent(token)}/live`, { gps: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy } });
      const el = $('#live-status');
      if (el) el.innerHTML = `✅ Ativo — última atualização às ${new Date().toLocaleTimeString('pt-BR')}`;
    } catch (e) { const el = $('#live-status'); if (el) el.textContent = e.message; }
  }, (err) => {
    const el = $('#live-status'); if (el) el.textContent = err.code === 1 ? 'Permissão de localização negada.' : 'Não foi possível obter a localização.';
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });

  // Se a pessoa fechar/minimizar, avisamos o servidor que o ao vivo parou.
  window.addEventListener('pagehide', () => stopLive(true));
}

// ---------- Fluxo principal ----------
async function submit(app, info) {
  const fixed = $('#c-fixed').checked;
  const live = $('#c-live').checked;
  if (!fixed) { toast('Marque a autorização da localização para continuar.', 'error'); return; }
  const btn = $('#go');
  btn.disabled = true; btn.textContent = 'Obtendo sua localização…';
  const gps = await new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
  btn.textContent = 'Confirmando…';
  try {
    const r = await api('POST', `/api/v/${encodeURIComponent(token)}`, { consent: true, live_consent: live, gps });
    if (r.live) { startLive(app, info); return; }
    app.innerHTML = `${brand(info.app_name)}<div class="card center"><div class="big">✅</div><h2 style="margin:10px 0">Localização confirmada!</h2>
      <p class="muted">${gps ? 'Obrigado — recebemos sua localização.' : 'Obrigado! Não foi possível obter a localização precisa pelo GPS, mas o registro foi concluído.'}</p></div>`;
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Autorizar e confirmar'; }
}

async function decline(app, info) {
  if (!confirm('Tem certeza que não quer autorizar? Nada será registrado.')) return;
  try { await api('POST', `/api/v/${encodeURIComponent(token)}`, { consent: false }); done(app, info.app_name, 'denied'); }
  catch (e) { toast(e.message, 'error'); }
}

async function main() {
  const app = $('#app');
  if (!token) { app.innerHTML = brand('Link inválido', 'Falta o código do link.'); return; }
  let info;
  try { info = await api('GET', `/api/v/${encodeURIComponent(token)}`); }
  catch { app.innerHTML = `${brand('Link não encontrado')}<div class="card"><div class="empty">Verifique o link recebido.</div></div>`; return; }
  if (info.done) return done(app, info.app_name, info.status);

  app.innerHTML = `${brand(info.app_name, 'Confirmação de localização')}
    <div class="card">
      ${info.purpose ? `<p>${esc(info.purpose)}</p>` : '<p>Para confirmar seus dados, precisamos registrar sua localização.</p>'}
      <div class="note">O que será registrado, <strong>somente se você autorizar</strong>:
        <ul>
          <li>Sua localização atual (uma vez), por IP e GPS.</li>
          <li>Opcional: sua localização em tempo real, <strong>enquanto esta tela ficar aberta</strong>.</li>
        </ul>
      </div>
      <label class="consent"><input type="checkbox" id="c-fixed"><span class="small">${esc(info.consent_fixed)}</span></label>
      <label class="consent"><input type="checkbox" id="c-live"><span class="small">${esc(info.consent_live)}</span></label>
      <button class="btn primary block" id="go">Autorizar e confirmar</button>
      <button class="btn block" id="no" style="margin-top:10px">Não autorizar</button>
      <p class="muted small" style="margin-top:12px">Seus dados são usados apenas para a confirmação e tratados conforme a LGPD. O tempo real pode ser interrompido por você a qualquer momento.</p>
    </div>`;
  $('#go').onclick = () => submit(app, info);
  $('#no').onclick = () => decline(app, info);
}

main();
