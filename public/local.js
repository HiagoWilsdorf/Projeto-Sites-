// Página pública de confirmação de localização (com consentimento explícito do cliente).
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
const token = params.get('t');

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

async function api(method, url, body) {
  const res = await fetch('/api/public' + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data;
}

const head = (title, sub) => `<div class="pub-head"><div class="brand-logo">R$</div><h1>${esc(title)}</h1>${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</div>`;

const DONE = {
  captured: ['✅', 'Localização já confirmada', 'Este link já foi utilizado. Obrigado!'],
  denied: ['Tudo bem', 'Nenhuma localização foi registrada', 'Você não autorizou o registro da localização. Pode fechar esta página.'],
  expired: ['⏳', 'Link expirado', 'Este link de confirmação expirou. Peça um novo ao atendente.'],
};

function doneScreen(app, business, status) {
  const [icon, title, sub] = DONE[status] || DONE.captured;
  app.innerHTML = `${head(business || 'Confirmação de localização')}
    <div class="card" style="text-align:center">
      <div style="font-size:48px;line-height:1.2">${icon}</div>
      <h2 style="margin:8px 0">${esc(title)}</h2>
      <p class="muted">${esc(sub)}</p>
    </div>`;
}

async function capture(app, info) {
  const btn = $('#go');
  const consent = $('#consent');
  if (!consent.checked) { toast('Marque a caixa de autorização para continuar.', 'error'); return; }
  btn.disabled = true;
  btn.textContent = 'Obtendo sua localização…';

  // GPS do navegador (pede permissão ao usuário). Se negar/indisponível, seguimos só com o IP.
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
    const r = await api('POST', `/local/${encodeURIComponent(token)}`, { consent: true, gps });
    app.innerHTML = `${head(info.business_name || 'Confirmação de localização')}
      <div class="card" style="text-align:center">
        <div style="font-size:48px">✅</div>
        <h2 style="margin:8px 0">Localização confirmada!</h2>
        <p class="muted">${gps ? 'Obrigado — recebemos sua localização.' : 'Obrigado! Não foi possível obter a localização precisa pelo GPS, mas o registro foi concluído.'}</p>
      </div>`;
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Autorizar e confirmar minha localização';
  }
}

async function decline(app, info) {
  if (!confirm('Tem certeza que não quer autorizar? Nenhuma localização será registrada.')) return;
  try {
    await api('POST', `/local/${encodeURIComponent(token)}`, { consent: false });
    doneScreen(app, info.business_name, 'denied');
  } catch (e) { toast(e.message, 'error'); }
}

async function main() {
  const app = $('#app');
  if (!token) { app.innerHTML = head('Link inválido', 'Falta o código do link.'); return; }
  let info;
  try { info = await api('GET', `/local/${encodeURIComponent(token)}`); }
  catch { app.innerHTML = head('Link não encontrado', 'Verifique o link enviado pelo atendente.'); return; }

  if (info.done) return doneScreen(app, info.business_name, info.status);

  app.innerHTML = `${head(info.business_name || 'Confirmação de localização', 'Confirmação de localização')}
    <div class="card">
      ${info.purpose ? `<p>${esc(info.purpose)}</p>` : '<p>Para confirmar seus dados neste atendimento, precisamos registrar sua localização atual.</p>'}
      <div class="pre small" style="background:var(--bg,#f6f7f9);padding:12px;border-radius:10px;margin:12px 0">
        O que será registrado, <strong>somente se você autorizar</strong>:
        <ul style="margin:8px 0 0;padding-left:18px">
          <li>Localização aproximada pelo seu IP (cidade/região).</li>
          <li>Localização precisa por GPS — o navegador vai <strong>pedir sua permissão</strong>.</li>
          <li>Data e hora do acesso.</li>
        </ul>
      </div>
      <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;margin:12px 0">
        <input type="checkbox" id="consent" style="margin-top:3px">
        <span class="small">${esc(info.consent_text)}</span>
      </label>
      <button class="btn primary" id="go" style="width:100%">Autorizar e confirmar minha localização</button>
      <button class="btn ghost" id="no" style="width:100%;margin-top:10px">Não autorizar</button>
      <p class="muted small" style="margin-top:12px">Seus dados são usados apenas para confirmação pela empresa e tratados conforme a LGPD.</p>
    </div>`;
  $('#go').onclick = () => capture(app, info);
  $('#no').onclick = () => decline(app, info);
}

main();
