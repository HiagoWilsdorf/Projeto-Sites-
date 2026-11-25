'use strict';
/* Gestão de Empréstimos — SPA sem dependências */

// ---------- Utilitários ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateBR = (s) => { if (!s) return '—'; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const dateTimeBR = (s) => {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const pct = (v) => `${(v * 100).toFixed(1).replace('.', ',')}%`;
const toCents = (v) => {
  if (typeof v === 'number') return Math.round(v * 100);
  let s = String(v || '').replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const centsToInput = (c) => (Number(c || 0) / 100).toFixed(2).replace('.', ',');
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

const METHOD = { simple: 'Juros simples', price: 'Tabela Price (compostos)', interest_only: 'Só juros + principal no final' };
const FREQ = { monthly: 'Mensal', biweekly: 'Quinzenal', weekly: 'Semanal', daily: 'Diária' };
const FREQ_UNIT = { monthly: 'ao mês', biweekly: 'por quinzena', weekly: 'por semana', daily: 'ao dia' };
const LOAN_STATUS = { active: ['Ativo', 'info'], paid: ['Quitado', 'ok'], canceled: ['Cancelado', ''] };
const MSG_STATUS = {
  sent: ['Enviada', 'ok'], pending_manual: ['Envio manual', 'warn'], failed: ['Falhou', 'danger'],
  logged: ['Registrada', ''], received: ['Nova', 'info'], read: ['Recebida', ''],
};
const TRIGGER = { before_due: 'Antes do vencimento', on_due: 'No dia do vencimento', after_due: 'Após o vencimento (atraso)' };
const VARS = ['cronograma', 'link', 'pendencias', 'nome', 'primeiro_nome', 'parcela', 'valor', 'valor_atualizado', 'vencimento', 'dias_atraso', 'dias_para_vencer', 'saldo_devedor', 'valor_emprestado', 'total_emprestimo', 'qtd_parcelas', 'pix', 'empresa', 'hoje', 'valor_pago'];

function situationBadge(i) {
  switch (i.situation) {
    case 'paid': return '<span class="badge ok">Paga</span>';
    case 'canceled': return '<span class="badge">Cancelada</span>';
    case 'overdue': return `<span class="badge danger">${i.days_late}d atraso</span>`;
    case 'due_today': return '<span class="badge warn">Vence hoje</span>';
    default: return i.paid_cents > 0 ? '<span class="badge info">Parcial</span>' : '<span class="badge">Em aberto</span>';
  }
}
const loanBadge = (s) => { const [t, c] = LOAN_STATUS[s] || [s, '']; return `<span class="badge ${c}">${t}</span>`; };
const msgBadge = (s) => { const [t, c] = MSG_STATUS[s] || [s, '']; return `<span class="badge ${c}">${t}</span>`; };
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

// Usuário logado e conta em foco (a conta central pode ver todas ou escolher uma).
let ME = null;
let ACCOUNTS = [];
let SYSTEM_NAME = 'Empréstimos';
const isAdmin = () => ME?.role === 'admin';
const getScope = () => { try { return isAdmin() ? localStorage.getItem('scope') || '' : ''; } catch { return ''; } };
const setScope = (v) => { try { localStorage.setItem('scope', v || ''); } catch { /* */ } };
const showAccountCol = () => isAdmin() && !getScope();
const accountName = (id) => ACCOUNTS.find((a) => a.id == id)?.name || '';

async function api(method, url, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (getScope()) headers['X-Account'] = getScope();
  const res = await fetch('/api' + url, {
    method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin',
  });
  if (res.status === 401 && !url.startsWith('/auth')) { renderAuth(); throw new Error('Sessão expirada'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

function modal(title, html, { wide = false, onMount } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-head"><h2 style="margin:0">${esc(title)}</h2><button type="button" data-close aria-label="Fechar">×</button></div>
    <div class="modal-body">${html}</div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('[data-close]').onclick = close;
  root.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
  onMount?.(root.querySelector('.modal'), close);
  return close;
}

function confirmDialog(text, okLabel = 'Confirmar') {
  return new Promise((resolve) => {
    modal('Confirmar', `<p>${esc(text)}</p><div class="modal-foot"><button class="btn" data-no>Cancelar</button><button class="btn primary" data-yes>${esc(okLabel)}</button></div>`, {
      onMount: (m, close) => {
        m.querySelector('[data-no]').onclick = () => { close(); resolve(false); };
        m.querySelector('[data-yes]').onclick = () => { close(); resolve(true); };
      },
    });
  });
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

async function guard(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, 'error'); } finally { if (btn) btn.disabled = false; }
}

function openWa(link) {
  if (link) window.open(link, '_blank', 'noopener');
}

// ---------- Layout / Rotas ----------
const NAV_ALL = [
  ['dashboard', '📊', 'Painel'],
  ['cadastros', '📝', 'Cadastros'],
  ['cobrancas', '🔔', 'Cobranças'],
  ['clientes', '👥', 'Clientes'],
  ['emprestimos', '💰', 'Empréstimos'],
  ['mensagens', '💬', 'Mensagens'],
  ['afiliados', '🤝', 'Afiliados e acessos', 'admin'],
  ['automacoes', '⚙️', 'Automações', 'admin'],
  ['relatorios', '📈', 'Relatórios'],
  ['config', '🔧', 'Configurações'],
];
const navItems = () => NAV_ALL.filter((n) => !n[3] || isAdmin());
const MOBILE_NAV = ['dashboard', 'cadastros', 'cobrancas', 'clientes', 'mais'];
const MORE_KEYS = ['emprestimos', 'mensagens', 'afiliados', 'automacoes', 'relatorios', 'config', 'mais'];
let badges = { cadastros: 0, cobrancas: 0, mensagens: 0 };

// Ícones em traço (iguais em qualquer aparelho, ao contrário de emojis).
const ICON_PATHS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  cadastros: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
  cobrancas: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  clientes: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  emprestimos: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  mensagens: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3a8.4 8.4 0 0 1 8.5 8.5z"/>',
  afiliados: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  automacoes: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  relatorios: '<path d="M3 3v18h18"/><path d="M8 17v-5M13 17V8M18 17v-9"/>',
  config: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  mais: '<path d="M3 12h18M3 6h18M3 18h18"/>',
  sair: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
};
const icon = (k) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[k] || ''}</svg>`;

function shell() {
  if ($('#main')) return;
  const scopeSel = isAdmin() ? `<div class="scope-box"><label>Visualizando</label><select class="scope-select">
      <option value="">🌐 Todas as contas</option>${ACCOUNTS.map((a) => `<option value="${a.id}">${a.role === 'admin' ? '⭐ ' : ''}${esc(a.name)}${a.active ? '' : ' (inativa)'}</option>`).join('')}</select></div>` : '';
  $('#app').innerHTML = `<div class="layout">
    <aside class="sidebar">
      <div class="brand"><div class="brand-logo">R$</div><span id="brand-name">${esc(SYSTEM_NAME)}</span></div>
      ${scopeSel}
      <nav class="nav">${navItems().map(([k, , t]) => `<a href="#/${k}" data-nav="${k}"><span class="ico">${icon(k)}</span>${t}<span class="badge count" data-badge="${k}" hidden></span></a>`).join('')}</nav>
      <div class="spacer"></div>
      <div class="me-box"><strong>${esc(ME.name)}</strong><span class="small muted">${isAdmin() ? 'Administrador (acesso total)' : 'Afiliado'}</span></div>
      <a class="btn sm" href="#" id="logout">Sair</a>
    </aside>
    <header class="mobile-top">
      <div class="brand-logo">R$</div>
      <div class="mt-title"><strong>${esc(SYSTEM_NAME)}</strong><span>${esc(ME.name)}</span></div>
      ${isAdmin() ? `<select class="scope-select mt-scope" aria-label="Conta visualizada"><option value="">Todas as contas</option>${ACCOUNTS.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>` : ''}
    </header>
    <main id="main"></main>
    <nav class="mobile-nav">${[...navItems(), ['mais', '', 'Mais']].filter(([k]) => MOBILE_NAV.includes(k)).map(([k, , t]) => `<a href="#/${k}" data-nav="${k}"><span class="ico">${icon(k)}<span class="badge count" data-badge="${k}" hidden></span></span><span class="lbl">${t.split(' ')[0]}</span></a>`).join('')}</nav>
  </div>`;
  for (const sel of $$('.scope-select')) {
    sel.value = getScope();
    sel.onchange = () => { setScope(sel.value); for (const o of $$('.scope-select')) o.value = sel.value; refreshBadges(); router(); };
  }
  $('#logout').onclick = async (e) => { e.preventDefault(); await logout(); };
}

function setBadges() {
  for (const [k, v] of Object.entries(badges)) {
    for (const el of $$(`[data-badge="${k}"]`)) { el.hidden = !v; el.textContent = v > 99 ? '99+' : v; }
  }
}

async function refreshBadges() {
  try {
    const d = await api('GET', '/dashboard');
    badges = { cadastros: d.totals.applications_review, cobrancas: d.overdue.length + d.upcoming.filter((u) => u.situation === 'due_today').length, mensagens: d.totals.pending_manual + d.totals.unread_inbound };
    setBadges();
  } catch { /* ignore */ }
}

const routes = [
  [/^\/?$/, () => go('/dashboard')],
  [/^\/dashboard$/, pageDashboard],
  [/^\/cobrancas$/, pageCollections],
  [/^\/cadastros$/, pageApplications],
  [/^\/cadastros\/(\d+)$/, pageApplication],
  [/^\/afiliados$/, pageAccounts],
  [/^\/mais$/, pageMore],
  [/^\/clientes$/, pageClients],
  [/^\/clientes\/(\d+)$/, pageClient],
  [/^\/emprestimos$/, pageLoans],
  [/^\/emprestimos\/novo$/, pageNewLoan],
  [/^\/emprestimos\/(\d+)$/, pageLoan],
  [/^\/mensagens$/, pageMessages],
  [/^\/automacoes$/, pageAutomations],
  [/^\/relatorios$/, pageReports],
  [/^\/config$/, pageSettings],
];

function go(path) { location.hash = '#' + path; }

async function router() {
  if (!ME) return;
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const query = new URLSearchParams(qs || '');
  shell();
  const key = path.split('/')[1] || 'dashboard';
  for (const a of $$('[data-nav]')) a.classList.toggle('active', a.dataset.nav === key || (a.dataset.nav === 'mais' && MORE_KEYS.includes(key) && !!a.closest('.mobile-nav')));
  // Cada navegação ganha um <main> novo: telas antigas ainda carregando escrevem num elemento descartado.
  const old = $('#main');
  const main = old.cloneNode(false);
  old.replaceWith(main);
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      main.innerHTML = '<div class="empty">Carregando…</div>';
      try { await fn(main, ...m.slice(1), query); } catch (e) { main.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
      window.scrollTo(0, 0);
      return;
    }
  }
  main.innerHTML = '<div class="card empty">Página não encontrada</div>';
}

// ---------- Login ----------
async function renderAuth() {
  const st = await (await fetch('/api/auth/status')).json();
  if (st.authenticated) { start(); return; }
  const setup = !st.configured;
  ME = null;
  $('#app').innerHTML = `<div class="auth-wrap"><form class="card auth-card" id="auth-form">
    <div class="brand"><div class="brand-logo">R$</div>Gestão de Empréstimos</div>
    <p class="muted small" style="text-align:center">${setup ? 'Primeiro acesso: crie a <strong>conta central</strong> (administrador). Depois você cadastra os afiliados.' : 'Entre com seu e-mail e senha.'}</p>
    ${setup ? '<div class="field"><label>Seu nome</label><input name="name" required autocomplete="name"></div>' : ''}
    <div class="field"><label>E-mail</label><input type="email" name="email" required autocomplete="username" autofocus></div>
    <div class="field"><label>Senha</label><input type="password" name="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 6 : 1}"></div>
    ${setup ? '<div class="field"><label>Confirmar senha</label><input type="password" name="confirm" autocomplete="new-password" required></div>' : ''}
    <button class="btn primary" style="width:100%">${setup ? 'Criar conta central e entrar' : 'Entrar'}</button>
  </form></div>`;
  $('#auth-form').onsubmit = (e) => {
    e.preventDefault();
    const f = formData(e.target);
    if (setup && f.password !== f.confirm) return toast('As senhas não conferem', 'error');
    guard(async () => {
      await api('POST', setup ? '/auth/setup' : '/auth/login', { name: f.name, email: f.email, password: f.password });
      start();
    }, e.submitter);
  };
}

async function start() {
  const me = await api('GET', '/me');
  ME = me.user;
  ACCOUNTS = me.accounts || [];
  if (getScope() && !ACCOUNTS.some((a) => String(a.id) === getScope())) setScope('');
  SYSTEM_NAME = me.system_name || 'Empréstimos';
  $('#app').innerHTML = '';
  shell();
  document.title = me.system_name || document.title;
  refreshBadges();
  router();
}

async function logout() {
  await api('POST', '/auth/logout');
  setScope('');
  renderAuth();
}

async function reloadAccounts() {
  if (!isAdmin()) return;
  ACCOUNTS = (await api('GET', '/me')).accounts || [];
  const box = $('.scope-select');
  if (box) { $('#app').innerHTML = ''; shell(); refreshBadges(); }
}

// No celular, tabelas viram cartões: cada célula ganha o nome da coluna como rótulo.
function cardifyTables(root = document) {
  for (const t of root.querySelectorAll('main table:not(.compact)')) {
    if (t.dataset.cards === '1') continue;
    t.dataset.cards = '1';
    t.classList.add('rtable');
    const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    for (const tr of t.querySelectorAll('tbody tr')) {
      [...tr.children].forEach((td, i) => {
        if (td.querySelector('.btn-row, .btn') && !heads[i]) td.classList.add('cell-actions');
        else if (heads[i]) {
          td.dataset.label = heads[i];
          // o conteúdo da célula fica junto, à direita do rótulo
          if (i > 0 && !td.querySelector(':scope > .cv')) {
            const wrap = document.createElement('span');
            wrap.className = 'cv';
            while (td.firstChild) wrap.appendChild(td.firstChild);
            td.appendChild(wrap);
          }
        }
        if (!td.textContent.trim() && !td.querySelector('.btn, img')) td.classList.add('cell-empty');
      });
    }
  }
}
let cardifyQueued = false;
new MutationObserver(() => {
  if (cardifyQueued) return;
  cardifyQueued = true;
  requestAnimationFrame(() => { cardifyQueued = false; cardifyTables(); });
}).observe(document.getElementById('app'), { childList: true, subtree: true });

window.addEventListener('hashchange', router);
setInterval(() => { if (ME) refreshBadges(); }, 60000);
renderAuth();

// ---------- Componentes compartilhados ----------
function installmentRow(i, { showClient = false } = {}) {
  const parcel = `${i.number}/${i.installments_count ?? ''}`.replace(/\/$/, '');
  return `<tr>
    ${showClient ? `<td><a href="#/clientes/${i.client_id}">${esc(i.client_name)}</a><div class="small muted">${esc(i.client_phone || '')}${showAccountCol() && i.account_name ? ` · ${esc(i.account_name)}` : ''}</div></td>` : ''}
    <td class="nowrap"><a href="#/emprestimos/${i.loan_id}">#${i.loan_id}</a> · ${parcel}</td>
    <td class="nowrap">${dateBR(i.due_date)}</td>
    <td class="num right">${brl(i.amount_cents)}</td>
    <td class="num right"><strong>${brl(i.remaining_cents)}</strong>${i.current_penalty_cents ? `<div class="small muted">+${brl(i.current_penalty_cents)} encargos</div>` : ''}</td>
    <td>${situationBadge(i)}${i.last_message ? `<div class="small muted">últ. aviso ${dateTimeBR(i.last_message.created_at)}</div>` : ''}</td>
    <td class="right"><div class="btn-row" style="justify-content:flex-end">
      <button class="btn sm wa" data-charge="${i.id}" data-client="${i.client_id}">Cobrar</button>
      <button class="btn sm primary" data-pay="${i.id}">Receber</button>
    </div></td>
  </tr>`;
}

function bindInstallmentActions(root, items, reload) {
  for (const b of $$('[data-pay]', root)) b.onclick = () => payDialog(items.find((i) => i.id == b.dataset.pay), reload);
  for (const b of $$('[data-charge]', root)) b.onclick = () => chargeDialog(items.find((i) => i.id == b.dataset.charge), reload);
}

function payDialog(inst, onDone) {
  modal(`Receber pagamento — parcela ${inst.number}`, `<form id="pay-form">
    <div class="card" style="background:var(--surface-2);box-shadow:none;margin-bottom:14px">
      <div class="summary-row"><span>Valor da parcela</span><strong class="num">${brl(inst.amount_cents)}</strong></div>
      ${inst.current_penalty_cents ? `<div class="summary-row"><span>Multa + juros de mora (${inst.days_late} dias)</span><strong class="num">${brl(inst.current_penalty_cents)}</strong></div>` : ''}
      ${inst.paid_cents ? `<div class="summary-row"><span>Já pago</span><strong class="num">−${brl(inst.paid_cents)}</strong></div>` : ''}
      <div class="summary-row"><span>Total devido hoje</span><strong class="num" id="pay-due">${brl(inst.remaining_cents)}</strong></div>
    </div>
    <div class="form-grid">
      <div class="field"><label>Valor recebido (R$)</label><input name="amount" inputmode="decimal" value="${centsToInput(inst.remaining_cents)}" required></div>
      <div class="field"><label>Data do pagamento</label><input type="date" name="paid_at" value="${todayISO()}" required></div>
      <div class="field"><label>Forma</label><select name="method"><option value="pix">PIX</option><option value="dinheiro">Dinheiro</option><option value="transferencia">Transferência</option><option value="cartao">Cartão</option><option value="outro">Outro</option></select></div>
      <div class="field"><label>Observação</label><input name="notes"></div>
    </div>
    ${inst.current_penalty_cents ? `<label class="check"><input type="checkbox" name="waive_penalty"> Isentar multa e juros de atraso (receber ${brl(inst.amount_cents - inst.paid_cents)})</label>` : ''}
    <label class="check"><input type="checkbox" name="carry_over" checked> Se o valor for maior, abater nas próximas parcelas</label>
    <label class="check"><input type="checkbox" name="send_receipt" checked> Enviar recibo ao cliente no WhatsApp</label>
    <div class="modal-foot"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">Confirmar recebimento</button></div>
  </form>`, {
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = close;
      const waive = m.querySelector('[name=waive_penalty]');
      if (waive) waive.onchange = () => {
        const v = waive.checked ? inst.amount_cents - inst.paid_cents : inst.remaining_cents;
        m.querySelector('[name=amount]').value = centsToInput(v);
        m.querySelector('#pay-due').textContent = brl(v);
      };
      m.querySelector('form').onsubmit = (e) => {
        e.preventDefault();
        const f = formData(e.target);
        guard(async () => {
          const r = await api('POST', `/installments/${inst.id}/pay`, {
            amount_cents: toCents(f.amount), paid_at: f.paid_at, method: f.method, notes: f.notes,
            waive_penalty: !!f.waive_penalty, carry_over: f.carry_over, send_receipt: f.send_receipt,
          });
          close();
          toast(`Pagamento registrado${r.leftover_cents ? ` — sobra de ${brl(r.leftover_cents)} não aplicada` : ''}`);
          if (r.receipt?.status === 'pending_manual' && r.receipt.wa_link) {
            if (await confirmDialog('Abrir o WhatsApp para enviar o recibo agora?', 'Abrir WhatsApp')) {
              openWa(r.receipt.wa_link);
              api('POST', `/messages/${r.receipt.id}/mark-sent`);
            }
          } else if (r.receipt?.status === 'failed') toast('Recibo não enviado: ' + r.receipt.error, 'error');
          refreshBadges();
          onDone?.();
        }, e.submitter);
      };
    },
  });
}

async function chargeDialog(inst, onDone) {
  const templates = await api('GET', '/templates');
  const pick = inst.situation === 'overdue' ? templates.find((t) => /atraso/i.test(t.name)) : inst.situation === 'due_today' ? templates.find((t) => /hoje/i.test(t.name)) : templates.find((t) => /lembrete/i.test(t.name));
  messageDialog({ clientId: inst.client_id, installmentId: inst.id, templates, templateId: pick?.id, title: `Cobrar ${inst.client_name || ''}`, onDone });
}

function messageDialog({ clientId, installmentId, loanId, templates, templateId, title = 'Enviar mensagem', onDone }) {
  modal(title, `<form>
    <div class="field"><label>Modelo</label><select name="template"><option value="">— Mensagem livre —</option>${templates.map((t) => `<option value="${t.id}" ${t.id === templateId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Mensagem</label><textarea name="body" rows="8"></textarea><div class="hint">Variáveis como {nome}, {valor}, {vencimento} são preenchidas automaticamente.</div></div>
    <div class="field"><label>Canal</label><select name="channel"><option value="whatsapp">WhatsApp</option><option value="crm">Somente registrar no CRM</option></select></div>
    <div class="modal-foot"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">Enviar</button></div>
  </form>`, {
    onMount: (m, close) => {
      const sel = m.querySelector('[name=template]');
      const ta = m.querySelector('[name=body]');
      const fill = async () => {
        const t = templates.find((x) => x.id == sel.value);
        if (!t) return;
        const r = await api('POST', '/preview-message', { body: t.body, client_id: clientId, installment_id: installmentId });
        ta.value = r.body;
      };
      sel.onchange = fill;
      fill();
      m.querySelector('[data-cancel]').onclick = close;
      m.querySelector('form').onsubmit = (e) => {
        e.preventDefault();
        const f = formData(e.target);
        guard(async () => {
          const msg = await api('POST', `/clients/${clientId}/messages`, { body: f.body, channel: f.channel, installment_id: installmentId, loan_id: loanId, kind: 'manual' });
          close();
          if (msg.status === 'pending_manual') {
            openWa(msg.wa_link);
            await api('POST', `/messages/${msg.id}/mark-sent`);
            toast('WhatsApp aberto com a mensagem pronta');
          } else if (msg.status === 'failed') toast('Falha no envio: ' + msg.error, 'error');
          else toast(msg.status === 'sent' ? 'Mensagem enviada' : 'Registrado no CRM');
          refreshBadges();
          onDone?.();
        }, e.submitter);
      };
    },
  });
}

// ---------- Painel ----------
async function pageDashboard(main) {
  const d = await api('GET', '/dashboard');
  const t = d.totals;
  const max = Math.max(1, ...d.months.flatMap((m) => [m.received, m.lent]));
  const monthName = (s) => new Date(s + '-15').toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
  main.innerHTML = `
    <div class="page-head"><div><h1>Painel${getScope() ? ` — ${esc(accountName(getScope()))}` : isAdmin() ? ' — todas as contas' : ''}</h1><div class="muted small">Hoje, ${dateBR(d.today)}</div></div>
      <div class="actions"><a class="btn primary" href="#/emprestimos/novo">+ Novo cliente / empréstimo</a></div></div>
    <div id="wa-status"></div>
    ${t.backup !== undefined && (!t.backup || !t.backup.ok || Date.now() - new Date(t.backup.at).getTime() > 36 * 3600000) ? `<div class="card wa-banner danger"><div><strong>${!t.backup ? 'Nenhum backup feito ainda.' : !t.backup.ok ? 'O último backup falhou.' : 'O backup diário está atrasado.'}</strong>
      <div class="small muted">${t.backup?.error ? esc(t.backup.error) : 'Os dados precisam de cópia de segurança diária.'}</div></div><a class="btn" href="#/config">Ver backups</a></div>` : ''}
    <div class="kpis">
      <div class="kpi primary"><div class="label">A receber</div><div class="value">${brl(t.receivable)}</div><div class="sub">${t.active_loans} empréstimo(s) ativo(s)</div></div>
      <div class="kpi"><div class="label">Capital na rua</div><div class="value">${brl(t.principal_out)}</div><div class="sub">principal ainda não recuperado</div></div>
      <div class="kpi danger"><div class="label">Em atraso</div><div class="value">${brl(t.overdue)}</div><div class="sub">${t.overdue_clients} cliente(s) · ${pct(t.delinquency_rate)} da carteira</div></div>
      <div class="kpi ok"><div class="label">Recebido no mês</div><div class="value">${brl(t.received_month)}</div><div class="sub">total: ${brl(t.received_total)}</div></div>
      <div class="kpi"><div class="label">Lucro realizado</div><div class="value">${brl(t.profit_realized)}</div><div class="sub">juros + encargos recebidos</div></div>
      <div class="kpi"><div class="label">Lucro projetado</div><div class="value">${brl(t.expected_profit)}</div><div class="sub">se tudo for pago</div></div>
    </div>
    ${t.pending_manual || t.unread_inbound || t.failed_messages || t.applications_review ? `<div class="card" style="margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <strong>Atenção:</strong>
      ${t.applications_review ? `<a class="badge primary" href="#/cadastros">${t.applications_review} cadastro(s) aguardando análise</a>` : ''}
      ${t.pending_manual ? `<a class="badge warn" href="#/mensagens?status=pending_manual">${t.pending_manual} mensagem(ns) aguardando envio manual</a>` : ''}
      ${t.unread_inbound ? `<a class="badge info" href="#/mensagens?status=received">${t.unread_inbound} resposta(s) de clientes</a>` : ''}
      ${t.failed_messages ? `<a class="badge danger" href="#/mensagens?status=failed">${t.failed_messages} falha(s) de envio</a>` : ''}
    </div>` : ''}
    <div class="grid cols-2">
      <div class="card"><div class="page-head" style="margin-bottom:6px"><h2 style="margin:0">Atrasados</h2><a href="#/cobrancas" class="small">ver todos</a></div>
        ${d.overdue.length ? d.overdue.slice(0, 8).map((i) => `<div class="list-item"><div class="main"><strong><a href="#/clientes/${i.client_id}">${esc(i.client_name)}</a></strong>
          <span class="small muted">Parcela ${i.number}/${i.installments_count} · venceu ${dateBR(i.due_date)}${showAccountCol() ? ` · ${esc(i.account_name || '')}` : ''}</span></div>
          <div class="right"><div class="num"><strong>${brl(i.remaining_cents)}</strong></div>${situationBadge(i)}</div></div>`).join('') : '<div class="empty">Nenhuma parcela em atraso 🎉</div>'}
      </div>
      <div class="card"><div class="page-head" style="margin-bottom:6px"><h2 style="margin:0">Próximos 7 dias</h2><a href="#/cobrancas" class="small">agenda</a></div>
        ${d.upcoming.length ? d.upcoming.slice(0, 8).map((i) => `<div class="list-item"><div class="main"><strong><a href="#/clientes/${i.client_id}">${esc(i.client_name)}</a></strong>
          <span class="small muted">Parcela ${i.number}/${i.installments_count} · ${dateBR(i.due_date)}${showAccountCol() ? ` · ${esc(i.account_name || '')}` : ''}</span></div>
          <div class="right"><div class="num"><strong>${brl(i.remaining_cents)}</strong></div>${situationBadge(i)}</div></div>`).join('') : '<div class="empty">Nenhum vencimento na próxima semana</div>'}
      </div>
    </div>
    <div class="card" style="margin-top:16px"><div class="page-head" style="margin-bottom:0"><h2 style="margin:0">Últimos 6 meses</h2>
      <div class="legend"><span><i style="background:var(--primary)"></i>Recebido</span><span><i style="background:var(--warn)"></i>Emprestado</span></div></div>
      <div class="bars">${d.months.map((m) => `<div class="bar-col" title="Recebido ${brl(m.received)} · Emprestado ${brl(m.lent)}">
        <div class="bar-pair"><div class="bar" style="height:${(m.received / max) * 100}%"></div><div class="bar alt" style="height:${(m.lent / max) * 100}%"></div></div>
        <div class="small muted">${monthName(m.month)}</div></div>`).join('')}</div>
    </div>`;
  if (!isAdmin() || getScope()) renderWaStatus($('#wa-status'));
}

async function renderWaStatus(el) {
  if (!el) return;
  try {
    const st = await api('GET', `/whatsapp/status${getScope() ? `?account=${getScope()}` : ''}`);
    if (st.provider === 'manual') {
      el.innerHTML = `<div class="card wa-banner warn"><div><strong>WhatsApp não conectado.</strong> As cobranças estão sendo geradas, mas você precisa tocar em enviar em cada uma.
        <div class="small muted">Conecte seu número para as cobranças saírem sozinhas.</div></div><a class="btn wa" href="#/config${getScope() ? `?conta=${getScope()}` : ''}">Conectar WhatsApp</a></div>`;
    } else if (!st.connected) {
      el.innerHTML = `<div class="card wa-banner danger"><div><strong>WhatsApp desconectado.</strong> As cobranças automáticas vão falhar até reconectar.
        <div class="small muted">${esc(st.error || st.detail || '')}</div></div><a class="btn wa" href="#/config${getScope() ? `?conta=${getScope()}` : ''}">Reconectar</a></div>`;
    } else el.innerHTML = '';
  } catch { el.innerHTML = ''; }
}

// ---------- Cobranças ----------
async function pageCollections(main, query) {
  const days = Number(query?.get?.('dias')) || 7;
  const d = await api('GET', `/collections?days=${days}`);
  const all = [...d.overdue, ...d.due_today, ...d.upcoming];
  const section = (title, items, empty) => `<div class="card"><h2>${title} <span class="badge">${items.length}</span>
    <span class="muted small" style="font-weight:400;margin-left:6px">${brl(items.reduce((s, i) => s + i.remaining_cents, 0))}</span></h2>
    ${items.length ? `<div class="table-wrap"><table><thead><tr><th>Cliente${showAccountCol() ? ' / conta' : ''}</th><th>Empréstimo</th><th>Vencimento</th><th class="right">Parcela</th><th class="right">Devido</th><th>Situação</th><th></th></tr></thead>
    <tbody>${items.map((i) => installmentRow(i, { showClient: true })).join('')}</tbody></table></div>` : `<div class="empty">${empty}</div>`}</div>`;
  main.innerHTML = `<div class="page-head"><div><h1>Cobranças</h1><div class="muted small">Agenda de recebimentos e atrasos</div></div>
    <div class="actions"><select id="days" class="btn">${[7, 15, 30, 60].map((n) => `<option value="${n}" ${n === days ? 'selected' : ''}>Próximos ${n} dias</option>`).join('')}</select>
    <button class="btn" id="run-auto">▶ Executar automações agora</button></div></div>
    ${section('🔴 Em atraso', d.overdue, 'Nenhuma parcela em atraso')}
    ${section('🟡 Vencem hoje', d.due_today, 'Nenhum vencimento hoje')}
    ${section('🟢 Próximos vencimentos', d.upcoming, 'Nada no período')}`;
  $('#days').onchange = (e) => go(`/cobrancas?dias=${e.target.value}`);
  $('#run-auto').onclick = (e) => runAutomationsUI(e.target, () => pageCollections(main, query));
  bindInstallmentActions(main, all, () => pageCollections(main, query));
}

async function runAutomationsUI(btn, after) {
  await guard(async () => {
    const preview = await api('POST', '/automations/run', { dryRun: true });
    if (!preview.preview.length) return toast('Nenhuma mensagem pendente pelas regras de automação');
    modal(`Automações — ${preview.preview.length} mensagem(ns)`, `<p class="muted small">Estas mensagens serão geradas agora pelas regras ativas:</p>
      <div style="max-height:50vh;overflow:auto">${preview.preview.map((p) => `<div class="card" style="box-shadow:none"><div class="small"><strong>${esc(p.client)}</strong> · ${esc(p.rule)} · ${p.channel === 'crm' ? 'CRM' : 'WhatsApp'}</div><div class="pre small" style="margin-top:6px">${esc(p.body)}</div></div>`).join('')}</div>
      <div class="modal-foot"><button class="btn" data-cancel>Cancelar</button><button class="btn primary" data-go>Gerar e enviar</button></div>`, {
      wide: true,
      onMount: (m, close) => {
        m.querySelector('[data-cancel]').onclick = close;
        m.querySelector('[data-go]').onclick = (e) => guard(async () => {
          const r = await api('POST', '/automations/run', {});
          close();
          toast(`${r.created} mensagem(ns): ${r.sent} enviadas, ${r.pending_manual} para envio manual, ${r.failed} falhas`);
          refreshBadges();
          after?.();
        }, e.target);
      },
    });
  }, btn);
}

// ---------- Clientes ----------
async function pageClients(main, query) {
  const archived = query?.get?.('arquivados') === '1';
  const q = query?.get?.('q') || '';
  const list = await api('GET', `/clients?q=${encodeURIComponent(q)}${archived ? '&archived=1' : ''}`);
  main.innerHTML = `<div class="page-head"><div><h1>Clientes</h1><div class="muted small">${list.length} cliente(s)</div></div>
    <div class="actions"><button class="btn primary" id="new-client">+ Novo cliente</button></div></div>
    <div class="toolbar"><input id="q" placeholder="Buscar por nome, telefone, CPF ou tag" value="${esc(q)}">
      <label class="check" style="margin:0"><input type="checkbox" id="arch" ${archived ? 'checked' : ''}> Arquivados</label></div>
    <div class="card">${list.length ? `<div class="table-wrap"><table><thead><tr><th>Nome</th>${showAccountCol() ? '<th>Conta</th>' : ''}<th>Telefone</th><th>Score</th><th class="right">Saldo devedor</th><th class="right">Em atraso</th></tr></thead><tbody>
      ${list.map((c) => `<tr class="click" data-id="${c.id}"><td><strong>${esc(c.name)}</strong>${c.tags ? `<div class="small muted">${esc(c.tags)}</div>` : ''}</td>${showAccountCol() ? `<td class="small">${esc(c.account_name || '')}</td>` : ''}
      <td class="nowrap">${esc(c.phone || '—')}</td><td class="stars">${stars(c.score)}</td>
      <td class="num right">${brl(c.balance_cents)}</td>
      <td class="num right">${c.overdue_cents ? `<span class="badge danger">${brl(c.overdue_cents)} · ${c.max_days_late}d</span>` : '<span class="muted">—</span>'}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Nenhum cliente encontrado</div>'}</div>`;
  let timer;
  $('#q').oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => go(`/clientes?q=${encodeURIComponent(e.target.value)}${archived ? '&arquivados=1' : ''}`), 350); };
  $('#arch').onchange = (e) => go(`/clientes${e.target.checked ? '?arquivados=1' : ''}`);
  for (const tr of $$('tr[data-id]', main)) tr.onclick = () => go(`/clientes/${tr.dataset.id}`);
  $('#new-client').onclick = () => go('/emprestimos/novo');
  setTimeout(() => { const el = $('#q'); if (q && el) { el.focus(); el.setSelectionRange(q.length, q.length); } });
}

function accountSelect(name, selected) {
  if (!isAdmin()) return '';
  return `<div class="field"><label>Conta responsável</label><select name="${name}">${ACCOUNTS.filter((a) => a.active).map((a) => `<option value="${a.id}" ${String(a.id) === String(selected || getScope() || ME.id) ? 'selected' : ''}>${a.role === 'admin' ? '⭐ ' : ''}${esc(a.name)}</option>`).join('')}</select></div>`;
}

function clientDialog(c, onSaved) {
  c = c || { score: 3, whatsapp_opt_in: 1 };
  modal(c.id ? 'Editar cliente' : 'Novo cliente', `<form class="form-grid">
    <div class="field full"><label>Nome completo *</label><input name="name" value="${esc(c.name)}" required></div>
    <div class="field"><label>WhatsApp / Telefone</label><input name="phone" inputmode="tel" placeholder="(11) 99999-9999" value="${esc(c.phone)}"></div>
    <div class="field"><label>CPF / Documento</label><input name="document" value="${esc(c.document)}"></div>
    <div class="field"><label>E-mail</label><input type="email" name="email" value="${esc(c.email)}"></div>
    <div class="field"><label>Score (confiança)</label><select name="score">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${n == c.score ? 'selected' : ''}>${stars(n)}</option>`).join('')}</select></div>
    <div class="field"><label>Data de nascimento</label><input type="date" name="birth_date" value="${esc(c.birth_date)}"></div>
    <div class="field"><label>Profissão</label><input name="occupation" value="${esc(c.occupation)}"></div>
    ${accountSelect('owner_id', c.owner_id)}
    <div class="field full"><label>Endereço</label><input name="address" value="${esc(c.address)}"></div>
    <div class="field full"><label>Tags</label><input name="tags" placeholder="ex.: indicação, comércio" value="${esc(c.tags)}"></div>
    <div class="field full"><label>Observações</label><textarea name="notes">${esc(c.notes)}</textarea></div>
    <div class="field full"><label class="check"><input type="checkbox" name="whatsapp_opt_in" ${c.whatsapp_opt_in ? 'checked' : ''}> Cliente aceita receber mensagens no WhatsApp</label></div>
    <div class="modal-foot full"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">Salvar</button></div>
  </form>`, {
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = close;
      m.querySelector('form').onsubmit = (e) => {
        e.preventDefault();
        guard(async () => {
          const saved = await api(c.id ? 'PUT' : 'POST', c.id ? `/clients/${c.id}` : '/clients', formData(e.target));
          close(); toast('Cliente salvo'); onSaved?.(saved);
        }, e.submitter);
      };
    },
  });
}

async function pageClient(main, id) {
  const c = await api('GET', `/clients/${id}`);
  const balance = c.loans.reduce((s, l) => s + (l.status === 'active' ? l.balance_cents : 0), 0);
  const overdue = c.loans.reduce((s, l) => s + (l.status === 'active' ? l.overdue_cents : 0), 0);
  const reload = () => pageClient(main, id);
  main.innerHTML = `<div class="page-head"><div><a href="#/clientes" class="small">← Clientes</a><h1>${esc(c.name)} ${c.archived ? '<span class="badge">Arquivado</span>' : ''}</h1>
    <div class="muted small">${esc(c.phone || 'sem telefone')} ${c.document ? '· CPF ' + esc(c.document) : ''} · <span class="stars">${stars(c.score)}</span>${isAdmin() ? ` · Conta: <strong>${esc(c.account_name || '')}</strong>` : ''}</div></div>
    <div class="actions">
      ${c.wa_link ? `<a class="btn wa" href="${esc(c.wa_link)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
      <button class="btn" id="send-msg">Enviar mensagem</button>
      <button class="btn" id="loc-check">📍 Verificar local</button>
      <button class="btn" id="edit">Editar</button>
      <a class="btn primary" href="#/emprestimos/novo?cliente=${c.id}">+ Empréstimo</a></div></div>
    <div class="kpis">
      <div class="kpi primary"><div class="label">Saldo devedor</div><div class="value">${brl(balance)}</div></div>
      <div class="kpi danger"><div class="label">Em atraso</div><div class="value">${brl(overdue)}</div></div>
      <div class="kpi"><div class="label">Total já pago</div><div class="value">${brl(c.loans.reduce((s, l) => s + l.paid_cents, 0))}</div></div>
      <div class="kpi"><div class="label">Empréstimos</div><div class="value">${c.loans.length}</div></div>
    </div>
    <div class="grid cols-2">
      <div>
        <div class="card"><h2>Empréstimos</h2>${c.loans.length ? c.loans.map((l) => `<div class="list-item"><div class="main">
          <strong><a href="#/emprestimos/${l.id}">#${l.id} · ${brl(l.principal_cents)}</a> ${loanBadge(l.status)}</strong>
          <span class="small muted">${dateBR(l.start_date)} · ${l.installments_count}x ${FREQ[l.frequency].toLowerCase()} · ${l.paid_count}/${l.installments_count} pagas</span>
          <div class="progress" style="margin-top:6px"><div style="width:${(l.paid_count / l.installments_count) * 100}%"></div></div></div>
          <div class="right"><div class="num"><strong>${brl(l.balance_cents)}</strong></div>${l.overdue_count ? `<span class="badge danger">${l.overdue_count} atrasada(s)</span>` : ''}</div></div>`).join('') : '<div class="empty">Nenhum empréstimo</div>'}</div>
        <div class="card"><h2>Dados</h2>
          <div class="summary-row"><span class="muted">Nascimento</span><span>${dateBR(c.birth_date)}</span></div>
          <div class="summary-row"><span class="muted">Profissão</span><span>${esc(c.occupation || '—')}</span></div>
          <div class="summary-row"><span class="muted">Renda</span><span>${c.income_cents ? brl(c.income_cents) : '—'}</span></div>
          <div class="summary-row"><span class="muted">E-mail</span><span>${esc(c.email || '—')}</span></div>
          <div class="summary-row"><span class="muted">Endereço</span><span>${esc(c.address || '—')}</span></div>
          <div class="summary-row"><span class="muted">Tags</span><span>${esc(c.tags || '—')}</span></div>
          <div class="summary-row"><span class="muted">WhatsApp</span><span>${c.whatsapp_opt_in ? 'Aceita mensagens' : 'Não enviar'}</span></div>
          ${c.notes ? `<div class="pre small" style="margin-top:8px">${esc(c.notes)}</div>` : ''}
          <div class="btn-row" style="margin-top:12px"><button class="btn sm" id="archive">${c.archived ? 'Desarquivar' : 'Arquivar'}</button>
          ${c.loans.length ? '' : '<button class="btn sm danger" id="del">Excluir</button>'}</div>
        </div>
        ${locationCard(c)}
        ${c.files?.length ? `<div class="card"><h2>Documentos do cadastro</h2><div class="file-grid">${c.files.map(fileThumb).join('')}</div>
          ${c.application_id ? `<a class="small" href="#/cadastros/${c.application_id}">ver análise do cadastro</a>` : ''}</div>` : ''}
        ${c.payments.length ? `<div class="card"><h2>Pagamentos</h2>${c.payments.slice(0, 15).map((p) => `<div class="list-item"><div class="main"><strong class="num">${brl(p.amount_cents)}</strong>
          <span class="small muted">${dateBR(p.paid_at)} · empréstimo #${p.loan_id} parcela ${p.number} · ${esc(p.method || '')}</span></div></div>`).join('')}</div>` : ''}
      </div>
      <div class="card"><h2>Histórico (CRM)</h2>
        <form id="note-form" style="display:flex;gap:8px;margin-bottom:14px"><input name="body" placeholder="Adicionar anotação (ligação, acordo, visita…)"><button class="btn">Salvar</button></form>
        <div class="timeline">${c.messages.length ? c.messages.map(msgBubble).join('') : '<div class="empty">Sem interações ainda</div>'}</div>
      </div>
    </div>`;
  $('#edit').onclick = () => clientDialog(c, reload);
  bindFileViewer(main);
  $('#send-msg').onclick = async () => messageDialog({ clientId: c.id, templates: await api('GET', '/templates'), onDone: reload });
  $('#loc-check').onclick = () => locationDialog(c, reload);
  $('#archive').onclick = () => guard(async () => { await api('PUT', `/clients/${c.id}`, { archived: !c.archived }); reload(); });
  if ($('#del')) $('#del').onclick = async () => { if (await confirmDialog('Excluir este cliente definitivamente?', 'Excluir')) guard(async () => { await api('DELETE', `/clients/${c.id}`); go('/clientes'); }); };
  $('#note-form').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); guard(async () => { await api('POST', `/clients/${c.id}/notes`, f); reload(); }, e.submitter); };
  bindMessageActions(main, reload);
  refreshBadges();
}

const LOC_STATUS = {
  pending: ['Aguardando cliente', 'info'],
  captured: ['Confirmada', 'ok'],
  denied: ['Não autorizada', 'warn'],
  expired: ['Expirado', ''],
};
function locBadge(s) { const [t, cls] = LOC_STATUS[s] || [s, '']; return `<span class="badge ${cls}">${t}</span>`; }

function locItem(l) {
  const lines = [];
  if (l.ip_place || l.ip) lines.push(`<div class="summary-row"><span class="muted">Por IP</span><span>${esc(l.ip_place || '—')}${l.ip ? ` <span class="small muted">(${esc(l.ip)})</span>` : ''}</span></div>`);
  if (l.gps_lat != null) lines.push(`<div class="summary-row"><span class="muted">GPS</span><span>${l.gps_lat.toFixed(5)}, ${l.gps_lng.toFixed(5)}${l.gps_accuracy != null ? ` <span class="small muted">±${Math.round(l.gps_accuracy)} m</span>` : ''}</span></div>`);
  if (l.gps_address) lines.push(`<div class="summary-row"><span class="muted">Endereço (GPS)</span><span>${esc(l.gps_address)}</span></div>`);
  if (l.expected_address) lines.push(`<div class="summary-row"><span class="muted">Endereço declarado</span><span>${esc(l.expected_address)}</span></div>`);
  const map = l.maps_url ? `<a class="btn sm" href="${esc(l.maps_url)}" target="_blank" rel="noopener">Ver no mapa</a>` : '';
  const when = l.captured_at ? dateTimeBR(l.captured_at) : `criado ${dateTimeBR(l.created_at)}`;
  return `<div class="list-item" style="display:block">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><strong class="small">${when}</strong>${locBadge(l.status)}</div>
    ${lines.join('') || '<div class="small muted" style="margin-top:4px">Sem dados registrados ainda.</div>'}
    ${map ? `<div class="btn-row" style="margin-top:8px">${map}</div>` : ''}</div>`;
}

function locationCard(c) {
  const list = (c.location_checks || []);
  return `<div class="card"><h2>Verificação de localização</h2>
    <p class="small muted" style="margin-top:-4px">Confirme onde o cliente está — sempre com o consentimento dele. Gere um link e envie pelo WhatsApp.</p>
    <button class="btn sm primary" id="loc-new" style="margin:4px 0 12px">📍 Gerar link de verificação</button>
    ${list.length ? list.map(locItem).join('') : '<div class="empty">Nenhuma verificação ainda</div>'}</div>`;
}

function locationDialog(c, reload) {
  modal('Verificar localização do cliente', `
    <p class="small muted">O link é enviado pelo <strong>WhatsApp conectado</strong> da sua conta. Ao abrir, o cliente vê um aviso e precisa <strong>autorizar</strong> antes de qualquer registro. O GPS preciso depende da permissão no navegador dele.</p>
    <form id="loc-form">
      <label>Mensagem/motivo mostrado ao cliente (opcional)
        <input name="purpose" maxlength="300" placeholder="Ex.: Confirmação de endereço para liberação do empréstimo"></label>
      <label>Validade do link
        <select name="hours"><option value="24">24 horas</option><option value="2">2 horas</option><option value="48">48 horas</option><option value="168">7 dias</option></select></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="send" checked> Enviar pelo WhatsApp agora${c.phone ? '' : ' <span class="small muted">(cliente sem telefone)</span>'}</label>
      <div class="modal-foot"><button type="button" class="btn" data-close-x>Cancelar</button><button class="btn primary">Gerar e enviar</button></div>
    </form>
    <div id="loc-result" hidden></div>`, {
    onMount: (m, close) => {
      m.querySelector('[data-close-x]').onclick = close;
      m.querySelector('#loc-form').onsubmit = (e) => {
        e.preventDefault();
        guard(async () => {
          const f = formData(e.target);
          const r = await api('POST', `/clients/${c.id}/location-check`, { purpose: f.purpose, hours: Number(f.hours), send: f.send });
          const box = m.querySelector('#loc-result');
          m.querySelector('#loc-form').hidden = true;
          box.hidden = false;
          const status = {
            sent: '<p class="small" style="color:var(--ok)">✅ Enviado pelo WhatsApp para o cliente.</p>',
            pending_manual: '<p class="small">Seu WhatsApp está no modo manual — toque para enviar:</p>',
            not_sent: '<p class="small">Link gerado. Envie ao cliente:</p>',
            failed: `<p class="small" style="color:var(--danger)">Não deu para enviar automaticamente${r.send_error ? ' (' + esc(r.send_error) + ')' : ''}. Envie manualmente:</p>`,
          }[r.sent] || '<p class="small">Link gerado:</p>';
          box.innerHTML = `${status}
            <input value="${esc(r.url)}" readonly style="width:100%;margin-bottom:8px" onclick="this.select()">
            <div class="btn-row">
              ${r.wa_link && r.sent !== 'sent' ? `<a class="btn wa" href="${esc(r.wa_link)}" target="_blank" rel="noopener">Enviar no WhatsApp</a>` : ''}
              <button class="btn" data-copy-link>Copiar link</button>
              <button class="btn primary" data-done>Concluir</button>
            </div>`;
          box.querySelector('[data-copy-link]').onclick = () => { navigator.clipboard?.writeText(r.url); toast('Link copiado'); };
          box.querySelector('[data-done]').onclick = () => { close(); reload(); };
        }, e.submitter);
      };
    },
  });
}

function msgBubble(m) {
  const cls = m.direction === 'in' ? 'in' : m.direction === 'note' ? 'note' : 'out';
  const label = m.direction === 'in' ? '📥 Cliente' : m.direction === 'note' ? (m.kind === 'receipt' ? '💵 Pagamento' : '📝 Anotação') : (m.channel === 'whatsapp' ? '📤 WhatsApp' : '📤 CRM');
  return `<div class="msg ${cls}"><div class="pre">${esc(m.body)}</div><div class="meta"><span>${label}</span><span>${dateTimeBR(m.created_at)}</span>
    ${m.direction === 'out' ? msgBadge(m.status) : ''}${m.error ? `<span class="small" style="color:var(--danger)">${esc(m.error)}</span>` : ''}
    ${m.direction === 'out' && ['pending_manual', 'failed'].includes(m.status) ? `<button class="btn sm wa" data-manual="${m.id}">Enviar no WhatsApp</button>` : ''}
    ${m.direction === 'out' && m.status === 'failed' ? `<button class="btn sm" data-retry="${m.id}">Tentar de novo</button>` : ''}</div></div>`;
}

function bindMessageActions(root, reload) {
  for (const b of $$('[data-manual]', root)) b.onclick = () => guard(async () => {
    const list = await api('GET', '/messages?limit=1000');
    const m = list.find((x) => x.id == b.dataset.manual);
    if (m?.wa_link) openWa(m.wa_link);
    await api('POST', `/messages/${b.dataset.manual}/mark-sent`);
    refreshBadges(); reload();
  }, b);
  for (const b of $$('[data-retry]', root)) b.onclick = () => guard(async () => {
    const m = await api('POST', `/messages/${b.dataset.retry}/retry`);
    toast(m.status === 'sent' ? 'Enviada' : m.status === 'failed' ? 'Falhou: ' + m.error : 'Pendente de envio manual', m.status === 'failed' ? 'error' : '');
    reload();
  }, b);
}

// ---------- Empréstimos ----------
async function pageLoans(main, query) {
  const status = query?.get?.('status') || 'active';
  const list = await api('GET', `/loans${status !== 'all' ? `?status=${status}` : ''}`);
  main.innerHTML = `<div class="page-head"><div><h1>Empréstimos</h1><div class="muted small">${list.length} registro(s) · saldo ${brl(list.reduce((s, l) => s + l.balance_cents, 0))}</div></div>
    <div class="actions"><a class="btn primary" href="#/emprestimos/novo">+ Novo empréstimo</a></div></div>
    <div class="tabs">${[['active', 'Ativos'], ['paid', 'Quitados'], ['canceled', 'Cancelados'], ['all', 'Todos']].map(([k, t]) => `<button data-st="${k}" class="${k === status ? 'active' : ''}">${t}</button>`).join('')}</div>
    <div class="card">${list.length ? `<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Nº</th>${showAccountCol() ? '<th>Conta</th>' : ''}<th>Data</th><th class="right">Emprestado</th><th>Condições</th><th>Progresso</th><th class="right">Saldo</th><th>Status</th></tr></thead><tbody>
    ${list.map((l) => `<tr class="click" data-id="${l.id}"><td><strong>${esc(l.client_name)}</strong></td><td>#${l.id}</td>${showAccountCol() ? `<td class="small">${esc(l.account_name || '')}</td>` : ''}<td class="nowrap">${dateBR(l.start_date)}</td>
      <td class="num right">${brl(l.principal_cents)}</td><td class="small">${l.installments_count}x ${FREQ[l.frequency].toLowerCase()} · ${String(l.interest_rate).replace('.', ',')}%</td>
      <td style="min-width:110px"><div class="small muted">${l.paid_count}/${l.installments_count}</div><div class="progress"><div style="width:${(l.paid_count / l.installments_count) * 100}%"></div></div></td>
      <td class="num right"><strong>${brl(l.balance_cents)}</strong></td>
      <td>${loanBadge(l.status)} ${l.overdue_count ? `<span class="badge danger">${l.max_days_late}d atraso</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Nenhum empréstimo</div>'}</div>`;
  for (const b of $$('[data-st]', main)) b.onclick = () => go(`/emprestimos?status=${b.dataset.st}`);
  for (const tr of $$('tr[data-id]', main)) tr.onclick = () => go(`/emprestimos/${tr.dataset.id}`);
}

async function pageNewLoan(main, query) {
  const [clients, settings] = await Promise.all([api('GET', '/clients'), api('GET', '/settings')]);
  const pre = query?.get?.('cliente');
  const preValue = query?.get?.('valor');
  const today = todayISO();
  let mode = pre || query?.get?.('existente') ? 'existing' : 'new';
  main.innerHTML = `<div class="page-head"><div><a href="#/emprestimos" class="small">← Empréstimos</a><h1>Novo cliente / empréstimo</h1>
    <div class="muted small">Para clientes que não passaram pelo link de cadastro. Clientes aprovados em <a href="#/cadastros">Cadastros</a> já aparecem em "Cliente já cadastrado".</div></div></div>
    <div class="grid cols-2">
      <form class="card" id="loan-form">
        <div class="tabs" style="margin-top:-6px"><button type="button" data-mode="new">Cliente novo</button><button type="button" data-mode="existing">Cliente já cadastrado</button></div>
        <div class="form-grid" data-section="new">
          <div class="field full"><label>Nome completo *</label><input name="nc_name"></div>
          <div class="field"><label>WhatsApp *</label><input name="nc_phone" inputmode="tel" placeholder="(11) 99999-9999"></div>
          <div class="field"><label>CPF</label><input name="nc_document"></div>
          <div class="field full"><label>Endereço</label><input name="nc_address"></div>
          <div class="field full"><label>Observações sobre o cliente</label><input name="nc_notes" placeholder="ex.: indicado por…, trabalha em…"></div>
          ${accountSelect('owner_id')}
        </div>
        <div class="form-grid" data-section="existing">
          <div class="field full"><label>Cliente *</label><select name="client_id"><option value="">Selecione…</option>
          ${clients.map((c) => `<option value="${c.id}" ${c.id == pre ? 'selected' : ''}>${esc(c.name)}${c.phone ? ' · ' + esc(c.phone) : ''}${showAccountCol() ? ' — ' + esc(c.account_name || '') : ''}</option>`).join('')}</select></div>
        </div>
        <h3 style="margin:8px 0 10px">Empréstimo</h3>
        <div class="form-grid">
        <div class="field"><label>Valor emprestado (R$) *</label><input name="principal" inputmode="decimal" placeholder="1.000,00" value="${preValue ? centsToInput(preValue) : ''}" required></div>
        <div class="field"><label>Data do empréstimo</label><input type="date" name="start_date" value="${today}"></div>
        <div class="field"><label>Frequência das parcelas</label><select name="frequency">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="field"><label>Nº de parcelas</label><input type="number" name="installments_count" min="1" max="600" value="${Number(query?.get?.('parcelas')) || 1}"></div>
        <div class="field"><label>Juros (% <span id="unit">ao mês</span>)</label><input name="interest_rate" inputmode="decimal" value="10"></div>
        <div class="field"><label>Cálculo</label><select name="method">${Object.entries(METHOD).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="field"><label>1º vencimento</label><input type="date" name="first_due_date"><div class="hint">Em branco = um período após a data do empréstimo</div></div>
        <div class="field"></div>
        <div class="field"><label>Multa por atraso (%)</label><input name="late_fee_percent" inputmode="decimal" value="${esc(settings.default_late_fee_percent)}"></div>
        <div class="field"><label>Juros de mora (% ao dia)</label><input name="late_interest_daily" inputmode="decimal" value="${esc(settings.default_late_interest_daily)}"></div>
        <div class="field full"><label>Observações / garantia</label><textarea name="notes" rows="3"></textarea></div>
        <div class="field full"><label class="check"><input type="checkbox" name="send_confirmation" ${settings.send_release_message === '1' ? 'checked' : ''}> Enviar ao cliente, no WhatsApp, a confirmação com todas as datas de cobrança</label></div>
      </div>
      <div class="modal-foot"><a class="btn" href="#/emprestimos">Cancelar</a><button class="btn primary">Cadastrar e liberar</button></div></form>
      <div class="card" id="sim"><h2>Simulação</h2><div class="empty">Preencha o valor para ver as parcelas</div></div>
    </div>`;
  const form = $('#loan-form');
  const payload = () => {
    const f = formData(form);
    return { ...f, principal_cents: toCents(f.principal), interest_rate: Number(String(f.interest_rate).replace(',', '.')) || 0,
      late_fee_percent: String(f.late_fee_percent).replace(',', '.'), late_interest_daily: String(f.late_interest_daily).replace(',', '.') };
  };
  let timer;
  const simulate = () => {
    clearTimeout(timer);
    $('#unit').textContent = FREQ_UNIT[form.frequency.value];
    timer = setTimeout(async () => {
      const p = payload();
      if (!(p.principal_cents > 0) || !$('#sim')) return;
      try {
        const s = await api('POST', '/loans/simulate', p);
        if (!$('#sim')) return;
        $('#sim').innerHTML = `<h2>Simulação</h2>
          <div class="summary-row"><span>Valor emprestado</span><strong class="num">${brl(p.principal_cents)}</strong></div>
          <div class="summary-row"><span>Juros totais</span><strong class="num">${brl(s.interest_cents)}</strong></div>
          <div class="summary-row"><span>Total a receber</span><strong class="num" style="color:var(--primary)">${brl(s.total_cents)}</strong></div>
          <div class="table-wrap" style="margin-top:10px;max-height:420px;overflow:auto"><table class="compact"><thead><tr><th>#</th><th>Vencimento</th><th class="right">Juros</th><th class="right">Amortização</th><th class="right">Parcela</th></tr></thead>
          <tbody>${s.installments.map((r) => `<tr><td>${r.number}</td><td>${dateBR(r.due_date)}</td><td class="num right">${brl(r.interest_cents)}</td><td class="num right">${brl(r.principal_cents)}</td><td class="num right"><strong>${brl(r.amount_cents)}</strong></td></tr>`).join('')}</tbody></table></div>`;
      } catch (e) { if ($('#sim')) $('#sim').innerHTML = `<h2>Simulação</h2><div class="empty">${esc(e.message)}</div>`; }
    }, 250);
  };
  form.oninput = simulate;
  form.onchange = simulate;
  const setMode = (m) => {
    mode = m;
    for (const b of $$('[data-mode]', form)) b.classList.toggle('active', b.dataset.mode === m);
    for (const sec of $$('[data-section]', form)) sec.hidden = sec.dataset.section !== m;
    form.nc_name.required = form.nc_phone.required = m === 'new';
    form.client_id.required = m === 'existing';
  };
  for (const b of $$('[data-mode]', form)) b.onclick = () => setMode(b.dataset.mode);
  setMode(mode);
  if (preValue) simulate();
  form.onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      const p = payload();
      for (const k of Object.keys(p)) if (k.startsWith('nc_')) delete p[k];
      if (mode !== 'new') delete p.owner_id;
      if (mode === 'new') {
        const f = formData(form);
        p.new_client = { name: f.nc_name, phone: f.nc_phone, document: f.nc_document, address: f.nc_address, notes: f.nc_notes };
        delete p.client_id;
      }
      const l = await api('POST', '/loans', p);
      toast('Cliente cadastrado e empréstimo liberado');
      const cf = l.confirmation;
      if (cf?.status === 'pending_manual' && cf.wa_link && await confirmDialog('Abrir o WhatsApp para enviar a confirmação com as datas de cobrança?', 'Abrir WhatsApp')) {
        openWa(cf.wa_link);
        await api('POST', `/messages/${cf.id}/mark-sent`);
      } else if (cf?.status === 'sent') toast('Confirmação enviada no WhatsApp');
      else if (cf?.status === 'failed') toast('Confirmação não enviada: ' + cf.error, 'error');
      refreshBadges();
      go(`/emprestimos/${l.id}`);
    }, e.submitter);
  };
}

async function pageLoan(main, id) {
  const l = await api('GET', `/loans/${id}`);
  const reload = () => pageLoan(main, id);
  const items = l.installments.map((i) => ({ ...i, installments_count: l.installments_count, client_id: l.client_id, client_name: l.client.name, client_phone: l.client.phone }));
  main.innerHTML = `<div class="page-head"><div><a href="#/clientes/${l.client_id}" class="small">← ${esc(l.client.name)}</a>
    <h1>Empréstimo #${l.id} ${loanBadge(l.status)}</h1>
    <div class="muted small">${dateBR(l.start_date)} · ${METHOD[l.method]} · ${String(l.interest_rate).replace('.', ',')}% ${FREQ_UNIT[l.frequency]} · ${l.installments_count}x ${FREQ[l.frequency].toLowerCase()}${isAdmin() ? ` · Conta: ${esc(l.account_name || '')}` : ''}</div></div>
    <div class="actions"><button class="btn" id="edit-loan">Encargos/observações</button>
    ${l.status === 'active' ? '<button class="btn danger" id="cancel-loan">Cancelar</button>' : ''}
    <button class="btn danger" id="del-loan">Excluir</button></div></div>
    <div class="kpis">
      <div class="kpi"><div class="label">Emprestado</div><div class="value">${brl(l.principal_cents)}</div></div>
      <div class="kpi"><div class="label">Total contratado</div><div class="value">${brl(l.total_cents)}</div><div class="sub">juros ${brl(l.total_cents - l.principal_cents)}</div></div>
      <div class="kpi ok"><div class="label">Recebido</div><div class="value">${brl(l.paid_cents)}</div><div class="sub">${l.paid_count}/${l.installments_count} parcelas</div></div>
      <div class="kpi primary"><div class="label">Saldo devedor</div><div class="value">${brl(l.balance_cents)}</div>${l.overdue_cents ? `<div class="sub" style="color:var(--danger)">${brl(l.overdue_cents)} em atraso</div>` : ''}</div>
    </div>
    <div class="card"><h2>Parcelas</h2><div class="table-wrap"><table><thead><tr><th>Parcela</th><th>Vencimento</th><th class="right">Valor</th><th class="right">Pago</th><th class="right">Devido hoje</th><th>Situação</th><th></th></tr></thead><tbody>
      ${items.map((i) => `<tr><td><strong>${i.number}/${l.installments_count}</strong></td><td class="nowrap">${dateBR(i.due_date)}${i.paid_at ? `<div class="small muted">pago ${dateBR(i.paid_at)}</div>` : ''}</td>
        <td class="num right">${brl(i.amount_cents)}</td><td class="num right">${brl(i.paid_cents)}</td>
        <td class="num right">${i.status === 'open' ? `<strong>${brl(i.remaining_cents)}</strong>${i.current_penalty_cents ? `<div class="small muted">+${brl(i.current_penalty_cents)} encargos</div>` : ''}` : '—'}</td>
        <td>${situationBadge(i)}</td>
        <td class="right">${i.status === 'open' && l.status === 'active' ? `<div class="btn-row" style="justify-content:flex-end">
          <button class="btn sm wa" data-charge="${i.id}">Cobrar</button><button class="btn sm" data-reneg="${i.id}">Renegociar</button><button class="btn sm primary" data-pay="${i.id}">Receber</button></div>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h2>Pagamentos</h2>${l.payments.length ? l.payments.map((p) => `<div class="list-item"><div class="main"><strong class="num">${brl(p.amount_cents)}</strong>
        <span class="small muted">${dateBR(p.paid_at)} · parcela ${p.number} · ${esc(p.method || '')}${p.notes ? ' · ' + esc(p.notes) : ''}</span></div>
        <button class="btn sm danger" data-undo="${p.id}">Estornar</button></div>`).join('') : '<div class="empty">Nenhum pagamento</div>'}</div>
      <div class="card"><h2>Condições</h2>
        <div class="summary-row"><span class="muted">Multa por atraso</span><span>${String(l.late_fee_percent).replace('.', ',')}%</span></div>
        <div class="summary-row"><span class="muted">Juros de mora</span><span>${String(l.late_interest_daily).replace('.', ',')}% ao dia</span></div>
        <div class="summary-row"><span class="muted">1º vencimento</span><span>${dateBR(l.first_due_date)}</span></div>
        ${l.notes ? `<div class="pre small" style="margin-top:8px">${esc(l.notes)}</div>` : ''}
      </div>
    </div>`;
  bindInstallmentActions(main, items, reload);
  for (const b of $$('[data-reneg]', main)) b.onclick = () => renegotiateDialog(items.find((i) => i.id == b.dataset.reneg), reload);
  for (const b of $$('[data-undo]', main)) b.onclick = async () => {
    if (await confirmDialog('Estornar este pagamento? A parcela volta a ficar em aberto.', 'Estornar')) guard(async () => { await api('DELETE', `/payments/${b.dataset.undo}`); toast('Pagamento estornado'); reload(); });
  };
  $('#edit-loan').onclick = () => modal('Encargos e observações', `<form><div class="form-grid">
      <div class="field"><label>Multa (%)</label><input name="late_fee_percent" value="${l.late_fee_percent}"></div>
      <div class="field"><label>Mora (% ao dia)</label><input name="late_interest_daily" value="${l.late_interest_daily}"></div>
      <div class="field full"><label>Observações</label><textarea name="notes">${esc(l.notes)}</textarea></div></div>
      <div class="modal-foot"><button class="btn primary">Salvar</button></div></form>`, {
    onMount: (m, close) => { m.querySelector('form').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); guard(async () => {
      await api('PUT', `/loans/${l.id}`, { notes: f.notes, late_fee_percent: f.late_fee_percent.replace(',', '.'), late_interest_daily: f.late_interest_daily.replace(',', '.') }); close(); reload(); }, e.submitter); }; },
  });
  if ($('#cancel-loan')) $('#cancel-loan').onclick = async () => {
    if (await confirmDialog('Cancelar este empréstimo? As parcelas em aberto serão canceladas e não haverá mais cobranças.', 'Cancelar empréstimo')) guard(async () => { await api('POST', `/loans/${l.id}/cancel`, {}); reload(); });
  };
  $('#del-loan').onclick = async () => {
    if (await confirmDialog('Excluir definitivamente este empréstimo, parcelas e pagamentos? Esta ação não pode ser desfeita.', 'Excluir')) guard(async () => { await api('DELETE', `/loans/${l.id}`); toast('Empréstimo excluído'); go(`/clientes/${l.client_id}`); });
  };
}

function renegotiateDialog(inst, onDone) {
  modal(`Renegociar parcela ${inst.number}`, `<form><div class="form-grid">
    <div class="field"><label>Novo vencimento</label><input type="date" name="due_date" value="${inst.due_date}"></div>
    <div class="field"><label>Novo valor (R$)</label><input name="amount" inputmode="decimal" value="${centsToInput(inst.amount_cents)}"></div>
    <div class="field full"><label class="check"><input type="checkbox" name="waived_penalty" ${inst.waived_penalty ? 'checked' : ''}> Isentar multa e juros de atraso desta parcela</label></div></div>
    <div class="modal-foot"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">Salvar</button></div></form>`, {
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = close;
      m.querySelector('form').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); guard(async () => {
        await api('PUT', `/installments/${inst.id}`, { due_date: f.due_date, amount_cents: toCents(f.amount), waived_penalty: f.waived_penalty }); close(); toast('Parcela atualizada'); onDone?.(); }, e.submitter); };
    },
  });
}

// ---------- Mensagens ----------
async function pageMessages(main, query) {
  const status = query?.get?.('status') || '';
  const tabs = [['', 'Todas'], ['pending_manual', 'Envio manual'], ['received', 'Respostas novas'], ['sent', 'Enviadas'], ['failed', 'Falhas']];
  const extra = status === 'received' ? '&direction=in' : '';
  const list = await api('GET', `/messages?limit=300${status ? `&status=${status}` : ''}${extra}`);
  const reload = () => pageMessages(main, query);
  main.innerHTML = `<div class="page-head"><div><h1>Mensagens</h1><div class="muted small">Central de envios do WhatsApp e do CRM</div></div>
    <div class="actions">${status === 'pending_manual' && list.length ? '<button class="btn wa" id="send-next">Enviar próxima</button>' : ''}
    <button class="btn" id="run-auto">▶ Executar automações</button></div></div>
    <div class="tabs">${tabs.map(([k, t]) => `<button data-st="${k}" class="${k === status ? 'active' : ''}">${t}</button>`).join('')}</div>
    <div class="card">${list.length ? list.map((m) => `<div class="list-item" style="align-items:flex-start"><div class="main" style="flex:1">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>${m.client_id ? `<a href="#/clientes/${m.client_id}">${esc(m.person_name)}</a>` : m.application_id ? `<a href="#/cadastros/${m.application_id}">${esc(m.person_name || m.person_phone || 'Novo contato')}</a> <span class="badge info">cadastro</span>` : esc(m.person_phone || 'Desconhecido')}</strong>
        ${showAccountCol() ? `<span class="small muted">${esc(m.account_name || '')}</span>` : ''}
        <span class="small muted">${m.direction === 'in' ? '📥 recebida' : m.direction === 'note' ? '📝 anotação' : m.channel === 'whatsapp' ? '📤 WhatsApp' : '📤 CRM'} · ${dateTimeBR(m.created_at)}</span>
        ${m.direction !== 'note' ? msgBadge(m.status) : ''}</div>
        <div class="pre small" style="margin-top:4px">${esc(m.body)}</div>${m.error ? `<div class="small" style="color:var(--danger)">${esc(m.error)}</div>` : ''}</div>
        <div class="btn-row">${m.direction === 'out' && ['pending_manual', 'failed'].includes(m.status) && m.wa_link ? `<button class="btn sm wa" data-open="${m.id}">Enviar</button>` : ''}
        ${m.direction === 'out' && m.status === 'failed' ? `<button class="btn sm" data-retry="${m.id}">Tentar de novo</button>` : ''}
        ${m.status === 'pending_manual' ? `<button class="btn sm" data-done="${m.id}" title="Marcar como enviada">✓</button>` : ''}
        <button class="btn sm danger" data-del="${m.id}" title="Excluir">🗑</button></div></div>`).join('') : '<div class="empty">Nenhuma mensagem</div>'}</div>`;
  for (const b of $$('[data-st]', main)) b.onclick = () => go(`/mensagens${b.dataset.st ? `?status=${b.dataset.st}` : ''}`);
  const byId = (id) => list.find((m) => m.id == id);
  for (const b of $$('[data-open]', main)) b.onclick = () => guard(async () => { openWa(byId(b.dataset.open).wa_link); await api('POST', `/messages/${b.dataset.open}/mark-sent`); refreshBadges(); reload(); });
  for (const b of $$('[data-done]', main)) b.onclick = () => guard(async () => { await api('POST', `/messages/${b.dataset.done}/mark-sent`); refreshBadges(); reload(); });
  for (const b of $$('[data-del]', main)) b.onclick = async () => { if (await confirmDialog('Excluir esta mensagem do histórico?', 'Excluir')) guard(async () => { await api('DELETE', `/messages/${b.dataset.del}`); reload(); }); };
  for (const b of $$('[data-retry]', main)) b.onclick = () => guard(async () => { const m = await api('POST', `/messages/${b.dataset.retry}/retry`); toast(m.status === 'failed' ? 'Falhou: ' + m.error : 'OK', m.status === 'failed' ? 'error' : ''); reload(); }, b);
  if ($('#send-next')) $('#send-next').onclick = () => guard(async () => { const m = list[list.length - 1]; openWa(m.wa_link); await api('POST', `/messages/${m.id}/mark-sent`); refreshBadges(); reload(); });
  $('#run-auto').onclick = (e) => runAutomationsUI(e.target, reload);
}

// ---------- Automações ----------
async function pageAutomations(main) {
  if (!isAdmin()) { main.innerHTML = '<div class="card empty">Somente a conta central edita as automações.</div>'; return; }
  const [rules, templates, settings] = await Promise.all([api('GET', '/rules'), api('GET', '/templates'), api('GET', '/settings')]);
  const reload = () => pageAutomations(main);
  const ruleDesc = (r) => r.trigger === 'before_due' ? `${r.days} dia(s) antes` : r.trigger === 'on_due' ? 'no dia' : `${r.days} dia(s) após${r.repeat_every ? `, repete a cada ${r.repeat_every} dia(s)${r.max_repeats ? ` (até ${r.max_repeats}x)` : ''}` : ''}`;
  main.innerHTML = `<div class="page-head"><div><h1>Automações</h1><div class="muted small">
    ${settings.automations_enabled === '1' ? '✅ Ativas — as cobranças são enviadas automaticamente uma vez por dia (pela manhã), para todas as contas.' : '⏸ Automações pausadas (ative em Configurações)'}
    As regras valem para a central e todos os afiliados; cada um envia pelo seu próprio WhatsApp.</div></div>
    <div class="actions"><button class="btn" id="run-auto">▶ Executar agora</button></div></div>
    <div class="card"><div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">Regras de cobrança</h2><button class="btn sm primary" id="new-rule">+ Regra</button></div>
      ${rules.length ? `<div class="table-wrap"><table><thead><tr><th>Regra</th><th>Quando</th><th>Modelo</th><th>Canal</th><th>Status</th><th></th></tr></thead><tbody>
      ${rules.map((r) => `<tr><td><strong>${esc(r.name)}</strong></td><td class="small">${TRIGGER[r.trigger]}<br>${ruleDesc(r)}</td><td>${esc(r.template_name)}</td>
        <td>${r.channel === 'crm' ? 'CRM' : 'WhatsApp'}</td><td>${r.active ? '<span class="badge ok">Ativa</span>' : '<span class="badge">Pausada</span>'}</td>
        <td class="right"><div class="btn-row" style="justify-content:flex-end"><button class="btn sm" data-edit-rule="${r.id}">Editar</button><button class="btn sm danger" data-del-rule="${r.id}">🗑</button></div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Nenhuma regra</div>'}</div>
    <div class="card"><div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">Modelos de mensagem</h2><button class="btn sm primary" id="new-tpl">+ Modelo</button></div>
      ${templates.map((t) => `<div class="list-item" style="align-items:flex-start"><div class="main" style="flex:1"><strong>${esc(t.name)}</strong><div class="pre small muted" style="margin-top:4px">${esc(t.body)}</div></div>
        <div class="btn-row"><button class="btn sm" data-edit-tpl="${t.id}">Editar</button><button class="btn sm danger" data-del-tpl="${t.id}">🗑</button></div></div>`).join('')}</div>`;

  $('#run-auto').onclick = (e) => runAutomationsUI(e.target, reload);
  $('#new-rule').onclick = () => ruleDialog(null, templates, reload);
  for (const b of $$('[data-edit-rule]', main)) b.onclick = () => ruleDialog(rules.find((r) => r.id == b.dataset.editRule), templates, reload);
  for (const b of $$('[data-del-rule]', main)) b.onclick = async () => { if (await confirmDialog('Excluir esta regra?', 'Excluir')) guard(async () => { await api('DELETE', `/rules/${b.dataset.delRule}`); reload(); }); };
  $('#new-tpl').onclick = () => templateDialog(null, reload);
  for (const b of $$('[data-edit-tpl]', main)) b.onclick = () => templateDialog(templates.find((t) => t.id == b.dataset.editTpl), reload);
  for (const b of $$('[data-del-tpl]', main)) b.onclick = async () => { if (await confirmDialog('Excluir este modelo?', 'Excluir')) guard(async () => { await api('DELETE', `/templates/${b.dataset.delTpl}`); reload(); }); };
}

function ruleDialog(r, templates, onDone) {
  r = r || { trigger: 'after_due', days: 1, repeat_every: 0, max_repeats: 0, channel: 'whatsapp', active: 1, template_id: templates[0]?.id };
  modal(r.id ? 'Editar regra' : 'Nova regra', `<form><div class="form-grid">
    <div class="field full"><label>Nome</label><input name="name" value="${esc(r.name)}" required></div>
    <div class="field"><label>Gatilho</label><select name="trigger">${Object.entries(TRIGGER).map(([k, v]) => `<option value="${k}" ${k === r.trigger ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label>Dias</label><input type="number" min="0" name="days" value="${r.days}"><div class="hint">Antes: dias antes do vencimento. Atraso: dias após.</div></div>
    <div class="field" data-after><label>Repetir a cada (dias)</label><input type="number" min="0" name="repeat_every" value="${r.repeat_every}"><div class="hint">0 = enviar uma única vez</div></div>
    <div class="field" data-after><label>Máximo de repetições</label><input type="number" min="0" name="max_repeats" value="${r.max_repeats}"><div class="hint">0 = sem limite (enquanto estiver em atraso)</div></div>
    <div class="field"><label>Modelo</label><select name="template_id">${templates.map((t) => `<option value="${t.id}" ${t.id === r.template_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Canal</label><select name="channel"><option value="whatsapp" ${r.channel === 'whatsapp' ? 'selected' : ''}>WhatsApp</option><option value="crm" ${r.channel === 'crm' ? 'selected' : ''}>Somente CRM (aviso interno)</option></select></div>
    <div class="field full"><label class="check"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> Regra ativa</label></div></div>
    <div class="modal-foot"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">Salvar</button></div></form>`, {
    onMount: (m, close) => {
      const trig = m.querySelector('[name=trigger]');
      const sync = () => { for (const el of $$('[data-after]', m)) el.style.display = trig.value === 'after_due' ? '' : 'none'; };
      trig.onchange = sync; sync();
      m.querySelector('[data-cancel]').onclick = close;
      m.querySelector('form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
        await api(r.id ? 'PUT' : 'POST', r.id ? `/rules/${r.id}` : '/rules', formData(e.target)); close(); toast('Regra salva'); onDone?.(); }, e.submitter); };
    },
  });
}

function templateDialog(t, onDone) {
  t = t || { name: '', body: '' };
  modal(t.id ? 'Editar modelo' : 'Novo modelo', `<form>
    <div class="field"><label>Nome</label><input name="name" value="${esc(t.name)}" required></div>
    <div class="field"><label>Texto</label><textarea name="body" rows="9" required>${esc(t.body)}</textarea></div>
    <div class="field"><label>Inserir variável</label><div class="chips">${VARS.map((v) => `<button type="button" data-var="${v}">{${v}}</button>`).join('')}</div></div>
    <div class="field"><label>Pré-visualização</label><div class="card pre small" id="tpl-prev" style="box-shadow:none;background:var(--surface-2)"></div></div>
    <div class="modal-foot"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">Salvar</button></div></form>`, {
    wide: true,
    onMount: (m, close) => {
      const ta = m.querySelector('[name=body]');
      const prev = async () => { m.querySelector('#tpl-prev').textContent = (await api('POST', '/preview-message', { body: ta.value })).body; };
      let timer; ta.oninput = () => { clearTimeout(timer); timer = setTimeout(prev, 300); }; prev();
      for (const b of $$('[data-var]', m)) b.onclick = () => { const p = ta.selectionStart; ta.setRangeText(`{${b.dataset.var}}`, p, ta.selectionEnd, 'end'); ta.focus(); prev(); };
      m.querySelector('[data-cancel]').onclick = close;
      m.querySelector('form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
        await api(t.id ? 'PUT' : 'POST', t.id ? `/templates/${t.id}` : '/templates', formData(e.target)); close(); toast('Modelo salvo'); onDone?.(); }, e.submitter); };
    },
  });
}

// ---------- Relatórios ----------
async function pageReports(main, query) {
  const t = todayISO();
  const from = query?.get?.('de') || t.slice(0, 8) + '01';
  const to = query?.get?.('ate') || t;
  const r = await api('GET', `/reports?from=${from}&to=${to}`);
  main.innerHTML = `<div class="page-head"><div><h1>Relatórios</h1><div class="muted small">${dateBR(r.from)} a ${dateBR(r.to)}</div></div></div>
    <form class="toolbar" id="period"><input type="date" name="de" value="${r.from}"><input type="date" name="ate" value="${r.to}"><button class="btn">Aplicar</button>
      <button type="button" class="btn" data-preset="month">Este mês</button><button type="button" class="btn" data-preset="last">Mês passado</button><button type="button" class="btn" data-preset="year">Este ano</button></form>
    <div class="kpis">
      <div class="kpi ok"><div class="label">Recebido</div><div class="value">${brl(r.received_cents)}</div><div class="sub">${r.payments.length} pagamento(s)</div></div>
      <div class="kpi"><div class="label">Emprestado</div><div class="value">${brl(r.lent_cents)}</div><div class="sub">${r.loans.length} empréstimo(s)</div></div>
      <div class="kpi"><div class="label">Previsto p/ período</div><div class="value">${brl(r.expected_cents)}</div><div class="sub">${r.expected_count} parcela(s)</div></div>
      <div class="kpi primary"><div class="label">Pontualidade</div><div class="value">${r.expected_count ? pct(r.paid_on_time / r.expected_count) : '—'}</div><div class="sub">${r.paid_on_time} paga(s) em dia</div></div>
    </div>
    <div class="grid cols-2">
      <div class="card"><h2>Pagamentos recebidos</h2>${r.payments.length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Cliente</th><th>Parc.</th><th>Forma</th><th class="right">Valor</th></tr></thead><tbody>
        ${r.payments.map((p) => `<tr><td>${dateBR(p.paid_at)}</td><td>${esc(p.client_name)}</td><td>${p.number}</td><td>${esc(p.method || '')}</td><td class="num right">${brl(p.amount_cents)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nenhum pagamento no período</div>'}</div>
      <div>
        ${showAccountCol() && Object.keys(r.by_account || {}).length ? `<div class="card"><h2>Recebido por conta</h2>${Object.entries(r.by_account).map(([k, v]) => `<div class="summary-row"><span>${esc(k)}</span><strong class="num">${brl(v)}</strong></div>`).join('')}</div>` : ''}
        <div class="card"><h2>Por forma de pagamento</h2>${Object.entries(r.by_method).map(([k, v]) => `<div class="summary-row"><span>${esc(k)}</span><strong class="num">${brl(v)}</strong></div>`).join('') || '<div class="empty">—</div>'}</div>
        <div class="card"><h2>Novos empréstimos</h2>${r.loans.length ? r.loans.map((l) => `<div class="summary-row"><span><a href="#/emprestimos/${l.id}">#${l.id}</a> ${esc(l.client_name)} · ${dateBR(l.start_date)}</span><strong class="num">${brl(l.principal_cents)}</strong></div>`).join('') : '<div class="empty">Nenhum</div>'}</div>
        <div class="card"><h2>Exportar planilhas (CSV)</h2><div class="btn-row">
          <a class="btn sm" href="/api/export/emprestimos.csv${getScope() ? `?account=${getScope()}` : ''}">Empréstimos</a><a class="btn sm" href="/api/export/parcelas.csv${getScope() ? `?account=${getScope()}` : ''}">Parcelas</a>
          <a class="btn sm" href="/api/export/pagamentos.csv${getScope() ? `?account=${getScope()}` : ''}">Pagamentos</a><a class="btn sm" href="/api/export/clientes.csv${getScope() ? `?account=${getScope()}` : ''}">Clientes</a></div>
          <div class="hint">Abre direto no Excel / Google Planilhas (separador “;”).</div></div>
      </div>
    </div>`;
  $('#period').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); go(`/relatorios?de=${f.de}&ate=${f.ate}`); };
  for (const b of $$('[data-preset]', main)) b.onclick = () => {
    const d = new Date(); const y = d.getFullYear(); const m = d.getMonth();
    const iso = (x) => { x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
    if (b.dataset.preset === 'month') go(`/relatorios?de=${iso(new Date(y, m, 1))}&ate=${iso(new Date(y, m + 1, 0))}`);
    if (b.dataset.preset === 'last') go(`/relatorios?de=${iso(new Date(y, m - 1, 1))}&ate=${iso(new Date(y, m, 0))}`);
    if (b.dataset.preset === 'year') go(`/relatorios?de=${y}-01-01&ate=${y}-12-31`);
  };
}

// ---------- Documentos (visualização) ----------
const APP_STATUS = {
  pending: ['Aguardando cliente', 'warn'], needs_changes: ['Correção solicitada', 'warn'], submitted: ['Para analisar', 'info'],
  approved: ['Aprovado', 'ok'], rejected: ['Recusado', 'danger'],
};
const appBadge = (s) => { const [t, c] = APP_STATUS[s] || [s, '']; return `<span class="badge ${c}">${t}</span>`; };
const FILE_STATUS = { pending: ['Aguardando análise', 'info'], approved: ['Aprovado', 'ok'], rejected: ['Recusado', 'danger'] };
const fileBadge = (s) => { const [t, c] = FILE_STATUS[s] || [s, '']; return `<span class="badge ${c}">${t}</span>`; };
const fileUrl = (f) => `/api/files/${f.id}${getScope() ? `?account=${getScope()}` : ''}`;
const isImg = (f) => /^image\/(jpeg|png|webp|gif)/.test(f.content_type || '');
const isVid = (f) => /^video\//.test(f.content_type || '');

function fileThumb(f) {
  const icon = isVid(f) ? '🎥' : f.content_type === 'application/pdf' ? '📄' : '🖼️';
  return `<button type="button" class="file-thumb" data-view="${f.id}" data-type="${esc(f.content_type || '')}" data-label="${esc(f.label)}">
    ${isImg(f) ? `<img src="${fileUrl(f)}" alt="${esc(f.label)}" loading="lazy">` : `<span class="file-icon">${icon}</span>`}
    <span class="small">${esc(f.label)}</span>${f.status ? fileBadge(f.status) : ''}</button>`;
}

function bindFileViewer(root) {
  for (const b of $$('[data-view]', root)) b.onclick = () => {
    const f = { id: b.dataset.view, content_type: b.dataset.type, label: b.dataset.label };
    const url = fileUrl(f);
    const body = isImg(f) ? `<img src="${url}" style="max-width:100%;border-radius:10px" alt="">`
      : isVid(f) ? `<video src="${url}" controls playsinline style="width:100%;border-radius:10px;background:#000"></video>`
        : f.content_type === 'application/pdf' ? `<iframe src="${url}" style="width:100%;height:70vh;border:0;border-radius:10px" title="PDF"></iframe>`
          : '<div class="empty">Pré-visualização indisponível para este formato.</div>';
    modal(f.label, `${body}<div class="modal-foot"><a class="btn" href="${url}${url.includes('?') ? '&' : '?'}download=1">⬇ Baixar</a><a class="btn" href="${url}" target="_blank" rel="noopener">Abrir em nova aba</a></div>`, { wide: true });
  };
}

// ---------- Cadastros ----------
async function pageApplications(main, query) {
  const tab = query?.get?.('aba') || 'submitted';
  const TABS = [['submitted', 'Para analisar'], ['open', 'Aguardando cliente'], ['approved', 'Aprovados'], ['rejected', 'Recusados']];
  const fetchStatus = async (st) => (st === 'open'
    ? [...await api('GET', '/applications?status=pending'), ...await api('GET', '/applications?status=needs_changes')]
    : api('GET', `/applications?status=${st}`));
  const list = await fetchStatus(tab);
  const acc = !isAdmin() || getScope() ? await api('GET', `/account-settings${getScope() ? `?account=${getScope()}` : ''}`).catch(() => null) : null;
  const reload = () => pageApplications(main, query);
  main.innerHTML = `<div class="page-head"><div><h1>Cadastros</h1><div class="muted small">Quem chama no WhatsApp recebe o link, envia dados e documentos, e você aprova ou recusa aqui.</div></div>
    <div class="actions"><button class="btn primary" id="new-link">+ Enviar link de cadastro</button></div></div>
    ${acc ? `<div class="card" style="margin-bottom:16px"><div class="small"><strong>Link de cadastro da conta${isAdmin() ? ` ${esc(acc.account.name)}` : ''}</strong> — divulgue em status, grupos ou anúncios:</div>
      <div style="display:flex;gap:8px;margin-top:6px"><input readonly value="${esc(acc.signup_url)}" id="signup-url"><button class="btn" id="copy-signup">Copiar</button></div></div>` : ''}
    <div class="tabs">${TABS.map(([k, t]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${t}</button>`).join('')}</div>
    <div class="card">${list.length ? `<div class="table-wrap"><table><thead><tr><th>Nome</th>${showAccountCol() ? '<th>Conta</th>' : ''}<th>WhatsApp</th><th class="right">Valor pedido</th><th>Documentos</th><th>Situação</th><th>Data</th></tr></thead><tbody>
      ${list.map((a) => `<tr class="click" data-id="${a.id}"><td><strong>${esc(a.name || 'Sem nome')}</strong><div class="small muted">${a.source === 'whatsapp' ? 'via WhatsApp' : a.source === 'link' ? 'via link' : 'manual'}</div></td>
        ${showAccountCol() ? `<td class="small">${esc(a.account_name || '')}</td>` : ''}
        <td class="nowrap">${esc(a.phone || '—')}</td><td class="num right">${a.requested_cents ? brl(a.requested_cents) : '—'}</td>
        <td class="small">${a.files_total} arquivo(s)${a.files_approved ? ` · <span style="color:var(--ok)">${a.files_approved} ok</span>` : ''}${a.files_rejected ? ` · <span style="color:var(--danger)">${a.files_rejected} recusado(s)</span>` : ''}</td>
        <td>${appBadge(a.status)}</td><td class="small nowrap">${dateTimeBR(a.submitted_at || a.created_at)}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="empty">${tab === 'submitted' ? 'Nenhum cadastro aguardando análise' : 'Nada por aqui'}</div>`}</div>`;
  for (const b of $$('[data-tab]', main)) b.onclick = () => go(`/cadastros?aba=${b.dataset.tab}`);
  for (const tr of $$('tr[data-id]', main)) tr.onclick = () => go(`/cadastros/${tr.dataset.id}`);
  if ($('#copy-signup')) $('#copy-signup').onclick = () => { navigator.clipboard?.writeText($('#signup-url').value); toast('Link copiado'); };
  $('#new-link').onclick = () => modal('Enviar link de cadastro', `<form><div class="form-grid">
      <div class="field"><label>Nome (opcional)</label><input name="name"></div>
      <div class="field"><label>WhatsApp com DDD *</label><input name="phone" required inputmode="tel" placeholder="(11) 99999-9999"></div>
      ${accountSelect('owner_id')}
      <div class="field full"><label class="check"><input type="checkbox" name="send" checked> Enviar o link pelo WhatsApp agora</label></div></div>
      <div class="modal-foot"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">Gerar link</button></div></form>`, {
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = close;
      m.querySelector('form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
        const r = await api('POST', '/applications', formData(e.target));
        close();
        if (r.message?.status === 'pending_manual' && r.message.wa_link) { openWa(r.message.wa_link); await api('POST', `/messages/${r.message.id}/mark-sent`); }
        else if (r.message?.status === 'sent') toast('Link enviado no WhatsApp');
        else if (r.message?.status === 'failed') toast('Não enviado: ' + r.message.error, 'error');
        modal('Link de cadastro', `<p class="small">Link pessoal deste cadastro:</p><div style="display:flex;gap:8px"><input readonly value="${esc(r.link)}" id="one-link"><button class="btn" id="copy-one">Copiar</button></div>`, {
          onMount: (mm) => { mm.querySelector('#copy-one').onclick = () => { navigator.clipboard?.writeText(r.link); toast('Copiado'); }; },
        });
        go('/cadastros?aba=open');
        reload();
      }, e.submitter); };
    },
  });
}

async function pageApplication(main, id) {
  const a = await api('GET', `/applications/${id}`);
  const reload = () => pageApplication(main, id);
  const closed = ['approved', 'rejected'].includes(a.status);
  const byType = a.document_types.map((t) => ({ t, files: a.files.filter((f) => f.document_type_id === t.id) }));
  const others = a.files.filter((f) => !a.document_types.some((t) => t.id === f.document_type_id));
  const row = (label, v) => `<div class="summary-row"><span class="muted">${label}</span><span>${v || '—'}</span></div>`;
  const fileCard = (f) => `<div class="review-file ${f.status}">
      ${fileThumb(f)}
      <div class="review-actions">
        ${f.reject_reason ? `<div class="small" style="color:var(--danger)">Motivo: ${esc(f.reject_reason)}</div>` : ''}
        <div class="small muted">${dateTimeBR(f.created_at)} · ${Math.max(1, Math.round(f.size / 1024))} KB</div>
        ${closed ? '' : `<div class="btn-row">${f.status !== 'approved' ? `<button class="btn sm" data-approve="${f.id}">✓ Aprovar</button>` : ''}${f.status !== 'rejected' ? `<button class="btn sm danger" data-reject="${f.id}">✕ Recusar</button>` : ''}</div>`}
      </div></div>`;
  main.innerHTML = `<div class="page-head"><div><a href="#/cadastros" class="small">← Cadastros</a><h1>${esc(a.name || 'Cadastro sem nome')} ${appBadge(a.status)}</h1>
    <div class="muted small">${esc(a.phone || '')}${isAdmin() ? ` · Conta: <strong>${esc(a.account_name || '')}</strong>` : ''} · criado ${dateTimeBR(a.created_at)}${a.submitted_at ? ` · enviado ${dateTimeBR(a.submitted_at)}` : ''}</div></div>
    <div class="actions">${a.wa_link ? `<a class="btn wa" href="${esc(a.wa_link)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
      <button class="btn" id="copy-link">Copiar link do cliente</button>
      ${a.client_id ? `<a class="btn primary" href="#/clientes/${a.client_id}">Ver cliente</a><a class="btn primary" href="#/emprestimos/novo?cliente=${a.client_id}">+ Empréstimo</a>` : ''}</div></div>
    ${!closed ? `<div class="card review-bar">
      <div class="small">${a.status === 'submitted' ? 'Revise cada documento abaixo e decida:' : a.status === 'needs_changes' ? 'Aguardando o cliente reenviar as correções.' : 'O cliente ainda não terminou de enviar o cadastro.'}</div>
      <div class="btn-row"><button class="btn" id="ask-changes">Pedir correções</button><button class="btn danger" id="reject-app">Recusar cadastro</button><button class="btn primary" id="approve-app">✓ Aprovar cadastro</button></div></div>` : ''}
    ${a.review_notes && a.status === 'needs_changes' ? `<div class="card" style="margin-bottom:16px"><strong>Correções pedidas:</strong><div class="pre small">${esc(a.review_notes)}</div></div>` : ''}
    <div class="grid cols-2">
      <div>
        <div class="card"><h2>Dados informados</h2>
          ${row('Nome', esc(a.name))}${row('CPF', esc(a.document))}${row('Nascimento', a.birth_date ? dateBR(a.birth_date) : '')}${row('WhatsApp', esc(a.phone))}
          ${row('E-mail', esc(a.email))}${row('Endereço', esc(a.address))}${row('Profissão', esc(a.occupation))}${row('Renda', a.income_cents ? brl(a.income_cents) : '')}
          ${row('Valor pedido', a.requested_cents ? `<strong>${brl(a.requested_cents)}</strong>` : '')}${row('Parcelas desejadas', a.requested_installments || '')}
          ${a.client_notes ? `<div class="pre small" style="margin-top:8px">${esc(a.client_notes)}</div>` : ''}
        </div>
        <div class="card"><h2>Conversa e histórico</h2>
          <div class="timeline">${a.messages.length ? a.messages.map(msgBubble).join('') : '<div class="empty">Sem mensagens</div>'}</div></div>
      </div>
      <div class="card"><h2>Documentos</h2>
        ${byType.map(({ t, files }) => `<div class="review-type"><div class="review-type-head"><strong>${esc(t.name)}</strong>${t.required ? '' : ' <span class="small muted">(opcional)</span>'}
          ${files.length ? '' : '<span class="badge warn">não enviado</span>'}</div>${files.map(fileCard).join('')}</div>`).join('')}
        ${others.length ? `<div class="review-type"><div class="review-type-head"><strong>Outros</strong></div>${others.map(fileCard).join('')}</div>` : ''}
      </div>
    </div>`;
  bindFileViewer(main);
  bindMessageActions(main, reload);
  $('#copy-link').onclick = () => { navigator.clipboard?.writeText(a.link); toast('Link copiado'); };
  for (const b of $$('[data-approve]', main)) b.onclick = () => guard(async () => { await api('PUT', `/application-files/${b.dataset.approve}`, { status: 'approved' }); reload(); }, b);
  for (const b of $$('[data-reject]', main)) b.onclick = () => modal('Recusar documento', `<form>
      <div class="field"><label>Motivo (o cliente verá esta mensagem)</label><input name="reason" required placeholder="ex.: foto borrada, documento vencido, rosto não aparece"></div>
      <div class="chips">${['Foto borrada', 'Documento cortado', 'Documento ilegível', 'Rosto não aparece', 'Documento vencido', 'Comprovante desatualizado'].map((r) => `<button type="button" data-reason="${r}">${r}</button>`).join('')}</div>
      <div class="modal-foot"><button class="btn danger">Recusar</button></div></form>`, {
    onMount: (m, close) => {
      for (const c of $$('[data-reason]', m)) c.onclick = () => { m.querySelector('[name=reason]').value = c.dataset.reason; };
      m.querySelector('form').onsubmit = (e) => { e.preventDefault(); guard(async () => { await api('PUT', `/application-files/${b.dataset.reject}`, { status: 'rejected', reason: formData(e.target).reason }); close(); reload(); }, e.submitter); };
    },
  });
  const after = async (r, okMsg) => {
    if (r.message?.status === 'pending_manual' && r.message.wa_link && await confirmDialog('Abrir o WhatsApp para avisar o cliente?', 'Abrir WhatsApp')) {
      openWa(r.message.wa_link); await api('POST', `/messages/${r.message.id}/mark-sent`);
    } else if (r.message?.status === 'failed') toast('Aviso não enviado: ' + r.message.error, 'error');
    else toast(okMsg);
    refreshBadges();
  };
  if ($('#ask-changes')) $('#ask-changes').onclick = () => modal('Pedir correções', `<form>
      <p class="small muted">Os documentos recusados (com o motivo) serão enviados ao cliente com o link para reenviar.</p>
      <div class="field"><label>Observação adicional (opcional)</label><textarea name="note" rows="3" placeholder="ex.: envie também um comprovante de renda mais recente"></textarea></div>
      <div class="modal-foot"><button class="btn primary">Enviar pedido de correção</button></div></form>`, {
    onMount: (m, close) => { m.querySelector('form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
      const r = await api('POST', `/applications/${a.id}/request-changes`, formData(e.target)); close(); await after(r, 'Correção solicitada ao cliente'); reload(); }, e.submitter); }; },
  });
  if ($('#reject-app')) $('#reject-app').onclick = () => modal('Recusar cadastro', `<form>
      <div class="field"><label>Motivo interno (opcional)</label><textarea name="note" rows="3"></textarea></div>
      <label class="check"><input type="checkbox" name="notify" checked> Avisar o cliente no WhatsApp</label>
      <div class="modal-foot"><button class="btn danger">Recusar cadastro</button></div></form>`, {
    onMount: (m, close) => { m.querySelector('form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
      const r = await api('POST', `/applications/${a.id}/reject`, formData(e.target)); close(); await after(r, 'Cadastro recusado'); reload(); }, e.submitter); }; },
  });
  if ($('#approve-app')) $('#approve-app').onclick = () => guard(async () => {
    let r;
    try {
      r = await api('POST', `/applications/${a.id}/approve`, { notify: true });
    } catch (err) {
      if (!(await confirmDialog(`${err.message}`, 'Aprovar mesmo assim'))) return;
      r = await api('POST', `/applications/${a.id}/approve`, { notify: true, force: true });
    }
    await after(r, 'Cadastro aprovado — cliente criado');
    if (await confirmDialog('Cadastro aprovado e cliente criado. Liberar o empréstimo agora?', 'Liberar empréstimo')) {
      go(`/emprestimos/novo?cliente=${r.client_id}${a.requested_cents ? `&valor=${a.requested_cents}` : ''}${a.requested_installments ? `&parcelas=${a.requested_installments}` : ''}`);
    } else go(`/clientes/${r.client_id}`);
  }, $('#approve-app'));
}

// ---------- Afiliados (conta central) ----------
async function pageAccounts(main) {
  if (!isAdmin()) { main.innerHTML = '<div class="card empty">Acesso restrito à conta central.</div>'; return; }
  const list = await api('GET', '/accounts');
  const reload = () => pageAccounts(main);
  const prov = { manual: 'Manual', evolution: 'Evolution', zapi: 'Z-API', cloud: 'Cloud API', webhook: 'CRM/URL' };
  main.innerHTML = `<div class="page-head"><div><h1>Afiliados e acessos</h1><div class="muted small">Afiliados veem só os próprios clientes. Administradores (⭐) têm acesso total, como a conta central e o suporte.</div></div>
    <div class="actions"><button class="btn primary" id="new-acc">+ Nova conta</button></div></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Conta</th><th class="right">Clientes</th><th class="right">Emprestado</th><th class="right">A receber</th><th class="right">Em atraso</th><th class="right">Recebido</th><th>Cadastros</th><th>WhatsApp</th><th></th></tr></thead><tbody>
    ${list.map((u) => `<tr><td><strong>${u.role === 'admin' ? '⭐ ' : ''}${esc(u.name)}</strong> ${u.role === 'admin' ? '<span class="badge primary">Administrador</span>' : ''} ${u.id === ME.id ? '<span class="badge">você</span>' : ''} ${u.active ? '' : '<span class="badge">inativa</span>'}<div class="small muted">${esc(u.email)}</div></td>
      <td class="num right">${u.clients}</td><td class="num right">${brl(u.lent_cents)}</td><td class="num right">${brl(u.receivable_cents)}</td>
      <td class="num right">${u.overdue_cents ? `<span style="color:var(--danger)">${brl(u.overdue_cents)}</span>` : '—'}</td><td class="num right">${brl(u.received_cents)}</td>
      <td>${u.pending_applications ? `<span class="badge info">${u.pending_applications} p/ analisar</span>` : '—'}</td>
      <td class="small">${prov[u.wa_provider] || u.wa_provider}</td>
      <td class="right"><div class="btn-row" style="justify-content:flex-end"><button class="btn sm" data-view="${u.id}">Ver painel</button><a class="btn sm" href="#/config?conta=${u.id}">WhatsApp</a><button class="btn sm" data-edit="${u.id}">Editar</button></div></td></tr>`).join('')}
    </tbody></table></div></div>`;
  for (const b of $$('[data-view]', main)) b.onclick = () => { setScope(b.dataset.view); for (const o of $$('.scope-select')) o.value = b.dataset.view; refreshBadges(); go('/dashboard'); };
  const dialog = (u) => modal(u ? 'Editar conta' : 'Nova conta', `<form><div class="form-grid">
      <div class="field full"><label>Nome</label><input name="name" required value="${esc(u?.name)}"></div>
      <div class="field"><label>E-mail (login)</label><input type="email" name="email" required value="${esc(u?.email)}"></div>
      <div class="field"><label>Telefone</label><input name="phone" value="${esc(u?.phone)}"></div>
      <div class="field"><label>${u ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial'}</label><input type="text" name="password" ${u ? '' : 'required minlength="6"'} autocomplete="new-password"></div>
      ${u?.id === ME.id ? '' : `<div class="field"><label>Tipo de acesso</label><select name="role"><option value="affiliate" ${u?.role !== 'admin' ? 'selected' : ''}>Afiliado — vê só os próprios clientes</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Administrador — acesso total (central / suporte)</option></select></div>`}
      ${u && u.id !== ME.id ? `<div class="field"><label class="check" style="margin-top:26px"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Conta ativa</label></div>` : ''}
    </div><div class="modal-foot"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">Salvar</button></div></form>`, {
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = close;
      m.querySelector('form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
        const f = formData(e.target);
        if (u && !f.password) delete f.password;
        await api(u ? 'PUT' : 'POST', u ? `/accounts/${u.id}` : '/accounts', f);
        close(); toast(u ? 'Conta atualizada' : `Conta criada. Passe o e-mail e a senha para ${f.name}.`);
        await reloadAccounts(); router();
      }, e.submitter); };
    },
  });
  $('#new-acc').onclick = () => dialog(null);
  for (const b of $$('[data-edit]', main)) b.onclick = () => dialog(list.find((u) => u.id == b.dataset.edit));
}

function pageMore(main) {
  main.innerHTML = `<div class="page-head"><h1>Mais</h1></div>${isAdmin() ? `<div class="card hide-mobile"><label>Visualizando</label><select class="scope-select"><option value="">🌐 Todas as contas</option>${ACCOUNTS.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>` : ''}
    <div class="card menu-list">${navItems().filter(([k]) => !MOBILE_NAV.includes(k)).map(([k, , t]) => `<a class="list-item" href="#/${k}"><span class="mi">${icon(k)}<span>${t}</span></span><span class="muted">›</span></a>`).join('')}
    <a class="list-item" href="#" id="logout-m" style="color:var(--danger)"><span class="mi">${icon('sair')}<span>Sair (${esc(ME.name)})</span></span></a></div>`;
  for (const sel of $$('.scope-select', main)) { sel.value = getScope(); sel.onchange = () => { setScope(sel.value); for (const o of $$('.scope-select')) o.value = sel.value; refreshBadges(); toast('Conta alterada'); }; }
  $('#logout-m').onclick = async (e) => { e.preventDefault(); await logout(); };
}

// ---------- Configurações ----------
const BOOL_SETTINGS = ['automations_enabled', 'send_receipt_on_payment', 'send_release_message', 'bot_enabled', 'bot_new_contact'];

async function pageSettings(main, query) {
  const target = isAdmin() ? (query?.get?.('conta') || getScope() || ME.id) : ME.id;
  const acc = await api('GET', `/account-settings${isAdmin() ? `?account=${target}` : ''}`);
  const s = acc.settings;
  const g = await api('GET', '/settings');
  const reload = () => pageSettings(main, query);
  const qs = isAdmin() ? `?account=${target}` : '';
  main.innerHTML = `<div class="page-head"><h1>Configurações</h1>
    ${isAdmin() ? `<div class="actions"><label class="small muted" style="margin:0">Configurar conta:</label><select id="cfg-acc" class="btn">${ACCOUNTS.map((a) => `<option value="${a.id}" ${String(a.id) === String(target) ? 'selected' : ''}>${a.role === 'admin' ? '⭐ ' : ''}${esc(a.name)}</option>`).join('')}</select></div>` : ''}</div>
    <form id="acc-form">
    <div class="card"><h2>Conta: ${esc(acc.account.name)}</h2><div class="form-grid">
      <div class="field"><label>Nome exibido nas mensagens</label><input name="business_name" value="${esc(s.business_name)}" placeholder="${esc(acc.account.name)}"></div>
      <div class="field"><label>Chave PIX para cobranças</label><input name="pix_key" value="${esc(s.pix_key)}" placeholder="CPF, e-mail, telefone ou aleatória"></div>
      <div class="field full"><label>Link de cadastro desta conta (para divulgar)</label><div style="display:flex;gap:8px"><input readonly value="${esc(acc.signup_url)}"><button type="button" class="btn" data-copy="${esc(acc.signup_url)}">Copiar</button></div></div>
    </div></div>
    <div class="card"><h2>WhatsApp desta conta</h2>
      <div id="wa-conn" class="wa-conn"><span class="muted small">Verificando conexão…</span></div>
      <div class="field"><label>Forma de envio</label><select name="wa_provider">
        <option value="zapi">Z-API — conecta o número por QR Code (serviço pago, ideal para a Vercel)</option>
        <option value="evolution">Evolution API — conecta o número por QR Code (precisa de servidor próprio)</option>
        <option value="cloud">WhatsApp Cloud API (oficial da Meta)</option>
        <option value="webhook">Meu CRM / automação (envia para uma URL: n8n, Make…)</option>
        <option value="manual">Manual — abre o WhatsApp com a mensagem pronta (sem conexão)</option></select></div>
      <div data-prov="zapi" class="form-grid">
        <div class="field"><label>ID da instância</label><input name="wa_zapi_instance" value="${esc(s.wa_zapi_instance)}"></div>
        <div class="field"><label>Token da instância</label><input name="wa_zapi_token" value="${esc(s.wa_zapi_token)}" autocomplete="off"></div>
        <div class="field"><label>Client-Token (segurança)</label><input name="wa_zapi_client_token" value="${esc(s.wa_zapi_client_token)}" autocomplete="off"></div>
      </div>
      <div data-prov="evolution" class="form-grid">
        <div class="field"><label>URL da API</label><input name="wa_evolution_url" value="${esc(s.wa_evolution_url)}" placeholder="https://evolution.seudominio.com"></div>
        <div class="field"><label>Nome da instância</label><input name="wa_evolution_instance" value="${esc(s.wa_evolution_instance)}"></div>
        <div class="field"><label>API Key</label><input name="wa_evolution_apikey" value="${esc(s.wa_evolution_apikey)}" autocomplete="off"></div>
      </div>
      <div data-prov="cloud" class="form-grid">
        <div class="field"><label>Token de acesso</label><input name="wa_cloud_token" value="${esc(s.wa_cloud_token)}" autocomplete="off"></div>
        <div class="field"><label>Phone Number ID</label><input name="wa_cloud_phone_id" value="${esc(s.wa_cloud_phone_id)}"></div>
        <div class="field"><label>Versão da API</label><input name="wa_cloud_api_version" value="${esc(s.wa_cloud_api_version)}"></div>
        <div class="hint full">A Meta só entrega texto livre se o cliente falou com você nas últimas 24h; lembretes fora disso exigem modelos aprovados.</div>
      </div>
      <div data-prov="webhook" class="form-grid">
        <div class="field full"><label>URL do seu CRM / automação</label><input name="wa_webhook_url" value="${esc(s.wa_webhook_url)}"><div class="hint">Cada mensagem vai como POST JSON <code>{"phone","message","account_id"}</code>.</div></div>
      </div>
      <div data-prov="zapi evolution cloud" style="margin-top:6px">
        <label>Webhook de mensagens recebidas (cole no painel do provedor)</label>
        <div style="display:flex;gap:8px"><input readonly value="${esc(acc.webhook_url)}"><button type="button" class="btn" data-copy="${esc(acc.webhook_url)}">Copiar</button></div>
        <div class="hint">É por ele que o site recebe as mensagens: novos contatos ganham o link de cadastro e clientes recebem o menu do bot.</div>
      </div>
      <div class="btn-row" style="margin-top:12px"><input id="test-phone" placeholder="Telefone para teste" style="max-width:220px"><button type="button" class="btn" id="test-wa">Enviar teste</button></div>
    </div>
    <div class="card save-bar"><button class="btn primary">Salvar conta</button></div>
    </form>
    ${isAdmin() ? `<form id="sys-form">
    <div class="card"><h2>Sistema (vale para todas as contas)</h2><div class="form-grid">
      <div class="field"><label>Nome do sistema</label><input name="system_name" value="${esc(g.system_name)}"></div>
      <div class="field"><label>Fuso horário</label><input name="timezone" value="${esc(g.timezone)}"></div>
      <div class="field"><label>Multa padrão por atraso (%)</label><input name="default_late_fee_percent" value="${esc(g.default_late_fee_percent)}"></div>
      <div class="field"><label>Juros de mora padrão (% ao dia)</label><input name="default_late_interest_daily" value="${esc(g.default_late_interest_daily)}"><div class="hint">0,033% ao dia ≈ 1% ao mês</div></div>
      <div class="field"><label>DDI padrão</label><input name="default_country_code" value="${esc(g.default_country_code)}"></div>
      <div class="field"></div>
      <div class="field full"><label class="check"><input type="checkbox" name="automations_enabled" ${g.automations_enabled === '1' ? 'checked' : ''}> Enviar cobranças automáticas (diariamente pela manhã)</label>
        <label class="check"><input type="checkbox" name="send_release_message" ${g.send_release_message === '1' ? 'checked' : ''}> Ao liberar um empréstimo, enviar a confirmação com as datas de cobrança</label>
        <label class="check"><input type="checkbox" name="send_receipt_on_payment" ${g.send_receipt_on_payment === '1' ? 'checked' : ''}> Enviar recibo ao registrar pagamento</label></div>
    </div></div>
    <div class="card"><h2>Bot do WhatsApp</h2>
      <label class="check"><input type="checkbox" name="bot_enabled" ${g.bot_enabled === '1' ? 'checked' : ''}> Ativar respostas automáticas</label>
      <label class="check"><input type="checkbox" name="bot_new_contact" ${g.bot_new_contact === '1' ? 'checked' : ''}> Novo contato recebe o link de cadastro</label>
      <div class="form-grid" style="margin-top:10px">
        <div class="field"><label>Boas-vindas + link de cadastro</label><textarea name="bot_welcome" rows="7">${esc(g.bot_welcome)}</textarea><div class="hint">{link} = link de cadastro da pessoa · {empresa}</div></div>
        <div class="field"><label>Cadastro iniciado e não terminado</label><textarea name="bot_pending" rows="7">${esc(g.bot_pending)}</textarea></div>
        <div class="field"><label>Cadastro em análise</label><textarea name="bot_in_review" rows="4">${esc(g.bot_in_review)}</textarea></div>
        <div class="field"><label>Menu para clientes (“oi”, “menu”…)</label><textarea name="bot_menu" rows="4">${esc(g.bot_menu)}</textarea><div class="hint">1 = próxima parcela · 2 = saldo · 3 = PIX · 4 = atendente</div></div>
        <div class="field full"><label>Resposta ao pedir atendente</label><input name="bot_human_reply" value="${esc(g.bot_human_reply)}"></div>
      </div></div>
    <div class="card"><h2>Mensagens da análise de cadastro</h2><div class="form-grid">
      <div class="field"><label>Correções necessárias</label><textarea name="msg_needs_changes" rows="6">${esc(g.msg_needs_changes)}</textarea><div class="hint">{pendencias} = documentos recusados e motivos · {link}</div></div>
      <div class="field"><label>Cadastro aprovado</label><textarea name="msg_approved" rows="6">${esc(g.msg_approved)}</textarea></div>
      <div class="field"><label>Cadastro recusado</label><textarea name="msg_rejected" rows="4">${esc(g.msg_rejected)}</textarea></div>
    </div></div>
    <div class="card save-bar"><button class="btn primary">Salvar sistema</button></div>
    </form>
    <div class="card"><div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">Documentos exigidos no cadastro</h2><button class="btn sm primary" id="new-doc">+ Documento</button></div>
      <div id="doc-list"></div></div>
    <div class="card"><div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">Backups de segurança</h2><button class="btn sm primary" id="run-backup">Fazer backup agora</button></div>
      <div id="backup-box"><span class="muted small">Carregando…</span></div></div>` : ''}
    <form class="card" id="pw-form" style="margin-top:16px"><h2>Alterar minha senha</h2><div class="form-grid">
      <div class="field"><label>Senha atual</label><input type="password" name="current" required autocomplete="current-password"></div>
      <div class="field"><label>Nova senha</label><input type="password" name="password" required minlength="6" autocomplete="new-password"></div></div>
      <button class="btn">Alterar senha</button></form>`;

  const form = $('#acc-form');
  form.wa_provider.value = s.wa_provider;
  const syncProv = () => { for (const el of $$('[data-prov]', main)) el.style.display = el.dataset.prov.split(' ').includes(form.wa_provider.value) ? '' : 'none'; };
  form.wa_provider.onchange = syncProv; syncProv();
  for (const b of $$('[data-copy]', main)) b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast('Copiado'); };
  if ($('#cfg-acc')) $('#cfg-acc').onchange = (e) => go(`/config?conta=${e.target.value}`);
  form.onsubmit = (e) => { e.preventDefault(); guard(async () => { await api('PUT', `/account-settings${qs}`, formData(form)); toast('Conta salva'); reload(); }, e.submitter); };
  $('#test-wa').onclick = (e) => guard(async () => {
    await api('PUT', `/account-settings${qs}`, formData(form));
    const r = await api('POST', `/whatsapp/test${qs}`, { phone: $('#test-phone').value });
    toast(r.status === 'pending_manual' ? 'Modo manual: nada foi enviado automaticamente' : 'Mensagem de teste enviada!');
  }, e.target);
  const conn = async () => {
    const el = $('#wa-conn');
    if (!el) return;
    const st = await api('GET', `/whatsapp/status${qs}`);
    const dot = st.provider === 'manual' ? 'warn' : st.connected ? 'ok' : 'danger';
    const label = st.provider === 'manual' ? 'Modo manual (sem conexão)' : st.connected ? 'Conectado — mensagens saem automaticamente' : 'Desconectado';
    el.innerHTML = `<span class="badge ${dot}">● ${label}</span> <span class="small muted">${esc(st.error || st.detail || '')}</span>
      ${['evolution', 'zapi'].includes(st.provider) ? `<button type="button" class="btn sm wa" id="wa-qr">${st.connected ? 'Reconectar' : 'Conectar com QR Code'}</button>` : ''}`;
    const qrBtn = $('#wa-qr');
    if (qrBtn) qrBtn.onclick = () => guard(async () => {
      const q = await api('POST', `/whatsapp/qr${qs}`);
      if (q.connected) { toast(q.message); return conn(); }
      const close = modal('Conectar WhatsApp', `<div style="text-align:center"><p class="small">No celular: WhatsApp → <strong>Aparelhos conectados</strong> → <strong>Conectar um aparelho</strong> e aponte para o código.</p>
        <img src="${esc(q.image)}" alt="QR Code" style="width:280px;max-width:100%;background:#fff;padding:8px;border-radius:12px">
        ${q.pairing_code ? `<p class="small muted">Ou use o código de pareamento: <strong>${esc(q.pairing_code)}</strong></p>` : ''}
        <p class="small muted" id="qr-wait">Aguardando leitura…</p></div>`);
      const timer = setInterval(async () => {
        if (!$('#qr-wait')) return clearInterval(timer);
        const s2 = await api('GET', `/whatsapp/status${qs}`).catch(() => ({}));
        if (s2.connected) { clearInterval(timer); close(); toast('WhatsApp conectado!'); conn(); }
      }, 3000);
    }, qrBtn);
  };
  conn().catch(() => {});

  if ($('#sys-form')) {
    $('#sys-form').onsubmit = (e) => {
      e.preventDefault();
      const f = formData(e.target);
      for (const k of BOOL_SETTINGS) f[k] = f[k] ? '1' : '0';
      for (const k of ['default_late_fee_percent', 'default_late_interest_daily']) f[k] = String(f[k]).replace(',', '.');
      guard(async () => { await api('PUT', '/settings', f); toast('Configurações do sistema salvas'); SYSTEM_NAME = f.system_name; $('#brand-name').textContent = f.system_name; }, e.submitter);
    };
    const renderDocs = async () => {
      const docs = await api('GET', '/document-types');
      const KIND = { image: '📷 Foto', video: '🎥 Vídeo', file: '📄 Foto ou PDF' };
      $('#doc-list').innerHTML = docs.filter((d) => d.active).map((d) => `<div class="list-item"><div class="main"><strong>${esc(d.name)}</strong>
        <span class="small muted">${KIND[d.kind]} · ${d.required ? 'obrigatório' : 'opcional'}${d.instructions ? ' · ' + esc(d.instructions) : ''}</span></div>
        <div class="btn-row"><button class="btn sm" data-edit-doc="${d.id}">Editar</button><button class="btn sm danger" data-del-doc="${d.id}">🗑</button></div></div>`).join('') || '<div class="empty">Nenhum documento exigido</div>';
      const dlg = (d) => modal(d ? 'Editar documento' : 'Novo documento', `<form><div class="form-grid">
          <div class="field full"><label>Nome</label><input name="name" required value="${esc(d?.name)}"></div>
          <div class="field"><label>Tipo</label><select name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${d?.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="field"><label>Ordem</label><input type="number" name="sort" value="${d?.sort ?? docs.length}"></div>
          <div class="field full"><label>Instruções para o cliente</label><input name="instructions" value="${esc(d?.instructions)}"></div>
          <div class="field full"><label class="check"><input type="checkbox" name="required" ${d?.required === false ? '' : 'checked'}> Obrigatório</label></div></div>
          <div class="modal-foot"><button class="btn primary">Salvar</button></div></form>`, {
        onMount: (m, close) => { m.querySelector('form').onsubmit = (e) => { e.preventDefault(); guard(async () => {
          await api(d ? 'PUT' : 'POST', d ? `/document-types/${d.id}` : '/document-types', formData(e.target)); close(); renderDocs(); }, e.submitter); }; },
      });
      $('#new-doc').onclick = () => dlg(null);
      for (const b of $$('[data-edit-doc]', main)) b.onclick = () => dlg(docs.find((d) => d.id == b.dataset.editDoc));
      for (const b of $$('[data-del-doc]', main)) b.onclick = async () => { if (await confirmDialog('Remover este documento da lista exigida?', 'Remover')) guard(async () => { await api('DELETE', `/document-types/${b.dataset.delDoc}`); renderDocs(); }); };
    };
    renderDocs();
    const renderBackups = async () => {
      const box = $('#backup-box');
      if (!box) return;
      const b = await api('GET', '/backups');
      const last = b.last;
      const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
      box.innerHTML = `<p class="small muted" style="margin-top:0">Todo dia às 03:00 é feita uma cópia completa do banco de dados (${b.encrypted ? 'criptografada' : '<strong style="color:var(--danger)">sem criptografia — configure a chave</strong>'}) e dos documentos novos, guardada em um armazenamento separado, em outra região. Cada cópia fica disponível por ${b.retention_days} dias.</p>
        ${last ? `<div class="summary-row"><span>Último backup</span><span>${last.ok ? '<span class="badge ok">OK</span>' : '<span class="badge danger">Falhou</span>'} ${dateTimeBR(last.at)}</span></div>
          ${last.ok ? `<div class="summary-row"><span>Conteúdo</span><span class="small">${last.counts?.clients ?? 0} clientes · ${last.counts?.loans ?? 0} empréstimos · ${last.counts?.applications ?? 0} cadastros · ${last.files_copied} documento(s) novo(s) copiado(s)</span></div>` : `<div class="small" style="color:var(--danger)">${esc(last.error || `${last.files_failed} documento(s) não copiados`)}</div>`}` : '<div class="empty small">Nenhum backup feito ainda.</div>'}
        ${b.error ? `<div class="small" style="color:var(--danger)">${esc(b.error)}</div>` : ''}
        ${b.list.length ? `<details style="margin-top:10px"><summary class="small"><strong>Cópias disponíveis (${b.list.length})</strong></summary>${b.list.slice(0, 30).map((x) => `<div class="list-item"><div class="main"><strong class="small">${dateTimeBR(x.uploaded_at)}</strong><span class="small muted">${fmtSize(x.size)}</span></div>
          <div class="btn-row"><a class="btn sm" href="/api/backups/download?pathname=${encodeURIComponent(x.pathname)}" title="Arquivo criptografado">⬇ Criptografado</a><a class="btn sm" href="/api/backups/download?pathname=${encodeURIComponent(x.pathname)}&format=json" title="Contém dados sensíveis">⬇ Legível (JSON)</a></div></div>`).join('')}</details>` : ''}`;
    };
    $('#run-backup').onclick = (e) => guard(async () => {
      toast('Fazendo backup…');
      const r = await api('POST', '/backups/run');
      toast(r.ok ? `Backup concluído (${r.files_copied} documento(s) novo(s) copiado(s))` : 'Backup falhou: ' + (r.error || 'documentos não copiados'), r.ok ? '' : 'error');
      renderBackups();
    }, e.target);
    renderBackups().catch((err) => { $('#backup-box').innerHTML = `<div class="small" style="color:var(--danger)">${esc(err.message)}</div>`; });
  }
  $('#pw-form').onsubmit = (e) => { e.preventDefault(); guard(async () => { await api('POST', '/auth/password', formData(e.target)); e.target.reset(); toast('Senha alterada'); }, e.submitter); };
}
