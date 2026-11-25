'use strict';
// Página pública: pede consentimento e, se autorizado, captura IP + GPS do navegador.
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

async function submit(app, info) {
  const btn = $('#go');
  if (!$('#consent').checked) { toast('Marque a caixa de autorização para continuar.', 'error'); return; }
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
    await api('POST', `/api/v/${encodeURIComponent(token)}`, { consent: true, gps });
    app.innerHTML = `${brand(info.app_name)}<div class="card center"><div class="big">✅</div><h2 style="margin:10px 0">Localização confirmada!</h2>
      <p class="muted">${gps ? 'Obrigado — recebemos sua localização.' : 'Obrigado! Não foi possível obter a localização precisa pelo GPS, mas o registro foi concluído.'}</p></div>`;
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Autorizar e confirmar minha localização'; }
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
      ${info.purpose ? `<p>${esc(info.purpose)}</p>` : '<p>Para confirmar seus dados, precisamos registrar sua localização atual.</p>'}
      <div class="note">O que será registrado, <strong>somente se você autorizar</strong>:
        <ul>
          <li>Localização aproximada pelo seu IP (cidade/região).</li>
          <li>Localização precisa por GPS — o navegador vai <strong>pedir sua permissão</strong>.</li>
          <li>Data e hora do acesso.</li>
        </ul>
      </div>
      <label class="consent"><input type="checkbox" id="consent"><span class="small">${esc(info.consent_text)}</span></label>
      <button class="btn primary block" id="go">Autorizar e confirmar minha localização</button>
      <button class="btn block" id="no" style="margin-top:10px">Não autorizar</button>
      <p class="muted small" style="margin-top:12px">Seus dados são usados apenas para a confirmação e tratados conforme a LGPD.</p>
    </div>`;
  $('#go').onclick = () => submit(app, info);
  $('#no').onclick = () => decline(app, info);
}

main();
