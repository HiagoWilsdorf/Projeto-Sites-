// Página pública de cadastro: o cliente preenche os dados e envia fotos, vídeos e documentos.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brlInput = (c) => (c ? (c / 100).toFixed(2).replace('.', ',') : '');
const toCents = (v) => {
  let s = String(v || '').replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const mb = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);
const KIND = { image: '📷 Foto', video: '🎥 Vídeo', file: '📄 Foto ou PDF' };
const ACCEPT = { image: 'image/*', video: 'video/*', file: 'image/*,application/pdf' };

const params = new URLSearchParams(location.search);
const token = params.get('t');
const slug = params.get('c');
let state = null;

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

async function api(method, url, body, headers = {}) {
  const isBlob = body instanceof Blob;
  const res = await fetch('/api/public' + url, {
    method,
    headers: body && !isBlob ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? (isBlob ? body : JSON.stringify(body)) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data;
}

const head = (title, sub) => `<div class="pub-head"><div class="brand-logo">R$</div><h1>${esc(title)}</h1>${sub ? `<div class="muted small">${sub}</div>` : ''}</div>`;

// ---------- Link geral da conta: começa pedindo nome e WhatsApp ----------
async function startPage() {
  let info;
  try { info = await api('GET', `/signup/${encodeURIComponent(slug)}`); } catch { return notFoundPage(); }
  document.title = `Cadastro — ${info.business_name}`;
  $('#app').innerHTML = `${head(info.business_name, 'Solicitação de empréstimo')}
    <form class="card" id="start">
      <p class="small muted" style="margin-top:0">Informe seu nome e WhatsApp para começar. Depois você vai enviar seus documentos.</p>
      <div class="field"><label>Nome completo</label><input name="name" required autocomplete="name"></div>
      <div class="field"><label>WhatsApp com DDD</label><input name="phone" required inputmode="tel" autocomplete="tel" placeholder="(11) 99999-9999"></div>
      <button class="btn primary" style="width:100%">Começar cadastro</button>
    </form>`;
  $('#start').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    e.submitter.disabled = true;
    try {
      const r = await api('POST', `/signup/${encodeURIComponent(slug)}`, f);
      location.replace(`/cadastro.html?t=${r.token}`);
    } catch (err) { toast(err.message, 'error'); e.submitter.disabled = false; }
  };
}

function notFoundPage() {
  $('#app').innerHTML = `${head('Link inválido')}<div class="card empty">Este link de cadastro não existe ou expirou. Peça um novo link pelo WhatsApp.</div>`;
}

// ---------- Cadastro ----------
async function load() {
  try { state = await api('GET', `/apply/${encodeURIComponent(token)}`); } catch { return notFoundPage(); }
  document.title = `Cadastro — ${state.business_name}`;
  render();
}

function render() {
  const s = state;
  if (s.status === 'submitted') return statusPage('⏳', 'Cadastro em análise', 'Recebemos seus dados e documentos. Vamos analisar e responder pelo WhatsApp.');
  if (s.status === 'approved') return statusPage('✅', 'Cadastro aprovado', 'Seu cadastro foi aprovado! Entraremos em contato pelo WhatsApp para a liberação.');
  if (s.status === 'rejected') return statusPage('❌', 'Cadastro não aprovado', 'Infelizmente não podemos seguir com o seu pedido neste momento.');
  const d = s.data;
  const required = s.document_types.filter((t) => t.required);
  const done = required.filter((t) => s.files.some((f) => f.document_type_id === t.id && f.status !== 'rejected')).length;
  const dataOk = !!(d.name && d.document && d.phone);
  $('#app').innerHTML = `${head(s.business_name, 'Cadastro para solicitação de empréstimo')}
    <div class="steps"><div class="${dataOk ? 'on' : ''}"></div><div class="${done === required.length ? 'on' : ''}"></div><div></div></div>
    ${s.status === 'needs_changes' ? `<div class="notice warn"><strong>Precisamos de algumas correções:</strong><div class="pre" style="margin-top:4px">${esc(s.review_notes || '')}</div></div>` : ''}
    <form class="card" id="data-form">
      <h2>1. Seus dados</h2>
      <div class="form-grid">
        <div class="field full"><label>Nome completo *</label><input name="name" value="${esc(d.name)}" required autocomplete="name"></div>
        <div class="field"><label>CPF *</label><input name="document" value="${esc(d.document)}" required inputmode="numeric" placeholder="000.000.000-00"></div>
        <div class="field"><label>Data de nascimento</label><input type="date" name="birth_date" value="${esc(d.birth_date)}"></div>
        <div class="field"><label>WhatsApp *</label><input name="phone" value="${esc(d.phone)}" required inputmode="tel"></div>
        <div class="field"><label>E-mail</label><input type="email" name="email" value="${esc(d.email)}" autocomplete="email"></div>
        <div class="field full"><label>Endereço completo</label><input name="address" value="${esc(d.address)}" autocomplete="street-address" placeholder="Rua, número, bairro, cidade"></div>
        <div class="field"><label>Profissão / trabalho</label><input name="occupation" value="${esc(d.occupation)}"></div>
        <div class="field"><label>Renda mensal (R$)</label><input name="income" value="${brlInput(d.income_cents)}" inputmode="decimal"></div>
        <div class="field"><label>Valor desejado (R$)</label><input name="requested" value="${brlInput(d.requested_cents)}" inputmode="decimal"></div>
        <div class="field"><label>Em quantas parcelas?</label><input type="number" min="0" max="60" name="requested_installments" value="${d.requested_installments || ''}"></div>
        <div class="field full"><label>Observações</label><textarea name="client_notes" rows="2">${esc(d.client_notes)}</textarea></div>
      </div>
      <button class="btn primary" style="width:100%">Salvar dados</button>
    </form>
    <div class="card"><h2>2. Documentos</h2>
      <p class="small muted" style="margin-top:-6px">Envie fotos nítidas, sem reflexo. Você pode tirar a foto na hora ou escolher da galeria.</p>
      ${s.document_types.map(docBlock).join('')}
    </div>
    <div class="card"><h2>3. Enviar para análise</h2>
      <p class="small muted" style="margin-top:-6px">${dataOk && done === required.length ? 'Tudo pronto! Envie para análise.' : `Faltam: ${[!dataOk ? 'seus dados (nome, CPF e WhatsApp)' : '', done < required.length ? `${required.length - done} documento(s)` : ''].filter(Boolean).join(' e ')}.`}</p>
      <button class="btn primary" id="submit" style="width:100%" ${dataOk && done === required.length ? '' : 'disabled'}>Enviar cadastro para análise</button>
    </div>`;

  $('#data-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    e.submitter.disabled = true;
    try {
      state = await api('PUT', `/apply/${token}`, { ...f, income_cents: toCents(f.income), requested_cents: toCents(f.requested), requested_installments: Number(f.requested_installments) || 0 });
      toast('Dados salvos');
      render();
    } catch (err) { toast(err.message, 'error'); e.submitter.disabled = false; }
  };
  for (const input of $$('input[type=file][data-type]')) input.onchange = () => uploadFiles(input);
  for (const b of $$('[data-del]')) b.onclick = async () => {
    if (!confirm('Remover este arquivo?')) return;
    try { await api('DELETE', `/apply/${token}/files/${b.dataset.del}`); await load(); } catch (err) { toast(err.message, 'error'); }
  };
  $('#submit').onclick = async (e) => {
    e.target.disabled = true;
    try { state = await api('POST', `/apply/${token}/submit`); render(); window.scrollTo(0, 0); } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
  };
}

function docBlock(t) {
  const files = state.files.filter((f) => f.document_type_id === t.id);
  const live = files.filter((f) => f.status !== 'rejected');
  const rejected = files.filter((f) => f.status === 'rejected');
  const ok = live.length > 0;
  const bad = !ok && rejected.length > 0;
  const statusTxt = (f) => (f.status === 'approved' ? '<span class="badge ok">Aprovado</span>' : f.status === 'rejected' ? `<span class="badge danger">Recusado${f.reject_reason ? ': ' + esc(f.reject_reason) : ''}</span>` : '<span class="badge info">Enviado</span>');
  return `<div class="doc ${ok ? 'ok' : bad ? 'bad' : ''}">
    <div class="doc-head"><div><strong>${esc(t.name)}</strong>${t.required ? '' : ' <span class="muted small">(opcional)</span>'}
      <div class="small muted">${KIND[t.kind] || ''}${t.instructions ? ' · ' + esc(t.instructions) : ''}</div></div>
      ${ok ? '<span style="font-size:20px">✅</span>' : ''}</div>
    ${files.length ? `<div class="doc-files">${files.map((f) => `<div class="doc-file"><span>${f.content_type?.startsWith('video') ? '🎥' : f.content_type === 'application/pdf' ? '📄' : '🖼️'} ${mb(f.size)}</span>
      <span style="display:flex;gap:6px;align-items:center">${statusTxt(f)}${f.status !== 'approved' ? `<button type="button" class="btn sm" data-del="${f.id}" aria-label="Remover">✕</button>` : ''}</span></div>`).join('')}</div>` : ''}
    <label class="btn ${ok ? '' : 'primary'} upload-btn">${ok ? 'Enviar outro arquivo' : bad ? 'Enviar novamente' : 'Enviar'}
      <input type="file" hidden data-type="${t.id}" data-kind="${t.kind}" accept="${ACCEPT[t.kind] || '*/*'}"></label>
    <div class="bar" hidden><div></div></div>
  </div>`;
}

async function uploadFiles(input) {
  const file = input.files[0];
  if (!file) return;
  const type = input.dataset.type;
  const lim = state.limits[input.dataset.kind] || state.limits.file;
  const block = input.closest('.doc');
  const bar = $('.bar', block);
  const fill = $('.bar > div', block);
  const ctype = file.type || (/\.heic$/i.test(file.name) ? 'image/heic' : '');
  if (!lim.types.includes(ctype)) return toast('Formato não aceito para este documento', 'error');
  if (file.size > lim.max) return toast(`Arquivo muito grande (máximo ${mb(lim.max)})`, 'error');
  $$('input, button', document).forEach((el) => { el.disabled = true; });
  bar.hidden = false;
  try {
    if (state.upload_mode === 'blob') {
      const { upload } = await import('/vendor/blob-client.js');
      const ext = (file.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || ctype.split('/')[1] || 'bin').toLowerCase();
      const blob = await upload(`${state.upload_prefix}doc.${ext}`, file, {
        access: 'private',
        handleUploadUrl: `/api/public/apply/${token}/upload`,
        clientPayload: JSON.stringify({ type }),
        contentType: ctype,
        multipart: file.size > 20 * 1024 * 1024,
        onUploadProgress: ({ percentage }) => { fill.style.width = `${percentage}%`; },
      });
      await api('POST', `/apply/${token}/files`, { type, pathname: blob.pathname, content_type: ctype });
    } else {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/public/apply/${token}/upload-local?type=${type}&name=${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader('Content-Type', ctype);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) fill.style.width = `${(e.loaded / e.total) * 100}%`; };
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText || '{}').error || 'Falha no envio')));
        xhr.onerror = () => reject(new Error('Falha de conexão'));
        xhr.send(file);
      });
    }
    toast('Arquivo enviado');
    await load();
  } catch (err) {
    toast(err.message || 'Falha no envio', 'error');
    $$('input, button', document).forEach((el) => { el.disabled = false; });
    bar.hidden = true;
  }
}

function statusPage(icon, title, text) {
  $('#app').innerHTML = `${head(state.business_name)}<div class="card big-status"><div class="icon">${icon}</div><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p></div>`;
}

if (token) load();
else if (slug) startPage();
else notFoundPage();
