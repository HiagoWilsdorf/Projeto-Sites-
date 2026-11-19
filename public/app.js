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
const VARS = ['cronograma', 'nome', 'primeiro_nome', 'parcela', 'valor', 'valor_atualizado', 'vencimento', 'dias_atraso', 'dias_para_vencer', 'saldo_devedor', 'valor_emprestado', 'total_emprestimo', 'qtd_parcelas', 'pix', 'empresa', 'hoje', 'valor_pago'];

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

async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin',
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
const NAV = [
  ['dashboard', '📊', 'Painel'],
  ['cobrancas', '🔔', 'Cobranças'],
  ['clientes', '👥', 'Clientes'],
  ['emprestimos', '💰', 'Empréstimos'],
  ['mensagens', '💬', 'Mensagens'],
  ['automacoes', '⚙️', 'Automações'],
  ['relatorios', '📈', 'Relatórios'],
  ['config', '🔧', 'Configurações'],
];
const MOBILE_NAV = ['dashboard', 'cobrancas', 'clientes', 'emprestimos', 'mensagens', 'config'];
let badges = { cobrancas: 0, mensagens: 0 };

function shell() {
  if ($('#main')) return;
  $('#app').innerHTML = `<div class="layout">
    <aside class="sidebar">
      <div class="brand"><div class="brand-logo">R$</div><span id="brand-name">Empréstimos</span></div>
      <nav class="nav">${NAV.map(([k, i, t]) => `<a href="#/${k}" data-nav="${k}"><span class="ico">${i}</span>${t}<span class="badge count" data-badge="${k}" hidden></span></a>`).join('')}</nav>
      <div class="spacer"></div>
      <a class="btn sm" href="#" id="logout">Sair</a>
    </aside>
    <main id="main"></main>
    <nav class="mobile-nav">${NAV.filter(([k]) => MOBILE_NAV.includes(k)).map(([k, i, t]) => `<a href="#/${k}" data-nav="${k}"><span class="ico">${i}</span>${t.split(' ')[0]}<span class="badge count" data-badge="${k}" hidden></span></a>`).join('')}</nav>
  </div>`;
  $('#logout').onclick = async (e) => { e.preventDefault(); await api('POST', '/auth/logout'); renderAuth(); };
}

function setBadges() {
  for (const [k, v] of Object.entries(badges)) {
    for (const el of $$(`[data-badge="${k}"]`)) { el.hidden = !v; el.textContent = v > 99 ? '99+' : v; }
  }
}

async function refreshBadges() {
  try {
    const d = await api('GET', '/dashboard');
    badges = { cobrancas: d.overdue.length + d.upcoming.filter((u) => u.situation === 'due_today').length, mensagens: d.totals.pending_manual + d.totals.unread_inbound };
    setBadges();
  } catch { /* ignore */ }
}

const routes = [
  [/^\/?$/, () => go('/dashboard')],
  [/^\/dashboard$/, pageDashboard],
  [/^\/cobrancas$/, pageCollections],
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
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const query = new URLSearchParams(qs || '');
  shell();
  const key = path.split('/')[1] || 'dashboard';
  for (const a of $$('[data-nav]')) a.classList.toggle('active', a.dataset.nav === key);
  const main = $('#main');
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
  $('#app').innerHTML = `<div class="auth-wrap"><form class="card auth-card" id="auth-form">
    <div class="brand"><div class="brand-logo">R$</div>Gestão de Empréstimos</div>
    <p class="muted small" style="text-align:center">${setup ? 'Primeiro acesso: crie a senha de acesso ao sistema.' : 'Digite sua senha para entrar.'}</p>
    <div class="field"><label>Senha</label><input type="password" name="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 6 : 1}" autofocus></div>
    ${setup ? '<div class="field"><label>Confirmar senha</label><input type="password" name="confirm" autocomplete="new-password" required></div>' : ''}
    <button class="btn primary" style="width:100%">${setup ? 'Criar senha e entrar' : 'Entrar'}</button>
  </form></div>`;
  $('#auth-form').onsubmit = (e) => {
    e.preventDefault();
    const f = formData(e.target);
    if (setup && f.password !== f.confirm) return toast('As senhas não conferem', 'error');
    guard(async () => {
      await api('POST', setup ? '/auth/setup' : '/auth/login', { password: f.password });
      start();
    }, e.submitter);
  };
}

async function start() {
  $('#app').innerHTML = '';
  shell();
  try { const s = await api('GET', '/settings'); $('#brand-name').textContent = s.business_name || 'Empréstimos'; document.title = s.business_name || document.title; } catch { /* */ }
  refreshBadges();
  router();
}

window.addEventListener('hashchange', router);
setInterval(refreshBadges, 60000);
renderAuth();

// ---------- Componentes compartilhados ----------
function installmentRow(i, { showClient = false } = {}) {
  const parcel = `${i.number}/${i.installments_count ?? ''}`.replace(/\/$/, '');
  return `<tr>
    ${showClient ? `<td><a href="#/clientes/${i.client_id}">${esc(i.client_name)}</a><div class="small muted">${esc(i.client_phone || '')}</div></td>` : ''}
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
    <div class="page-head"><div><h1>Painel</h1><div class="muted small">Hoje, ${dateBR(d.today)}</div></div>
      <div class="actions"><a class="btn primary" href="#/emprestimos/novo">+ Novo cliente / empréstimo</a></div></div>
    <div id="wa-status"></div>
    <div class="kpis">
      <div class="kpi primary"><div class="label">A receber</div><div class="value">${brl(t.receivable)}</div><div class="sub">${t.active_loans} empréstimo(s) ativo(s)</div></div>
      <div class="kpi"><div class="label">Capital na rua</div><div class="value">${brl(t.principal_out)}</div><div class="sub">principal ainda não recuperado</div></div>
      <div class="kpi danger"><div class="label">Em atraso</div><div class="value">${brl(t.overdue)}</div><div class="sub">${t.overdue_clients} cliente(s) · ${pct(t.delinquency_rate)} da carteira</div></div>
      <div class="kpi ok"><div class="label">Recebido no mês</div><div class="value">${brl(t.received_month)}</div><div class="sub">total: ${brl(t.received_total)}</div></div>
      <div class="kpi"><div class="label">Lucro realizado</div><div class="value">${brl(t.profit_realized)}</div><div class="sub">juros + encargos recebidos</div></div>
      <div class="kpi"><div class="label">Lucro projetado</div><div class="value">${brl(t.expected_profit)}</div><div class="sub">se tudo for pago</div></div>
    </div>
    ${t.pending_manual || t.unread_inbound || t.failed_messages ? `<div class="card" style="margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <strong>Atenção:</strong>
      ${t.pending_manual ? `<a class="badge warn" href="#/mensagens?status=pending_manual">${t.pending_manual} mensagem(ns) aguardando envio manual</a>` : ''}
      ${t.unread_inbound ? `<a class="badge info" href="#/mensagens?status=received">${t.unread_inbound} resposta(s) de clientes</a>` : ''}
      ${t.failed_messages ? `<a class="badge danger" href="#/mensagens?status=failed">${t.failed_messages} falha(s) de envio</a>` : ''}
    </div>` : ''}
    <div class="grid cols-2">
      <div class="card"><div class="page-head" style="margin-bottom:6px"><h2 style="margin:0">Atrasados</h2><a href="#/cobrancas" class="small">ver todos</a></div>
        ${d.overdue.length ? d.overdue.slice(0, 8).map((i) => `<div class="list-item"><div class="main"><strong><a href="#/clientes/${i.client_id}">${esc(i.client_name)}</a></strong>
          <span class="small muted">Parcela ${i.number}/${i.installments_count} · venceu ${dateBR(i.due_date)}</span></div>
          <div class="right"><div class="num"><strong>${brl(i.remaining_cents)}</strong></div>${situationBadge(i)}</div></div>`).join('') : '<div class="empty">Nenhuma parcela em atraso 🎉</div>'}
      </div>
      <div class="card"><div class="page-head" style="margin-bottom:6px"><h2 style="margin:0">Próximos 7 dias</h2><a href="#/cobrancas" class="small">agenda</a></div>
        ${d.upcoming.length ? d.upcoming.slice(0, 8).map((i) => `<div class="list-item"><div class="main"><strong><a href="#/clientes/${i.client_id}">${esc(i.client_name)}</a></strong>
          <span class="small muted">Parcela ${i.number}/${i.installments_count} · ${dateBR(i.due_date)}</span></div>
          <div class="right"><div class="num"><strong>${brl(i.remaining_cents)}</strong></div>${situationBadge(i)}</div></div>`).join('') : '<div class="empty">Nenhum vencimento na próxima semana</div>'}
      </div>
    </div>
    <div class="card" style="margin-top:16px"><div class="page-head" style="margin-bottom:0"><h2 style="margin:0">Últimos 6 meses</h2>
      <div class="legend"><span><i style="background:var(--primary)"></i>Recebido</span><span><i style="background:var(--warn)"></i>Emprestado</span></div></div>
      <div class="bars">${d.months.map((m) => `<div class="bar-col" title="Recebido ${brl(m.received)} · Emprestado ${brl(m.lent)}">
        <div class="bar-pair"><div class="bar" style="height:${(m.received / max) * 100}%"></div><div class="bar alt" style="height:${(m.lent / max) * 100}%"></div></div>
        <div class="small muted">${monthName(m.month)}</div></div>`).join('')}</div>
    </div>`;
  renderWaStatus($('#wa-status'));
}

async function renderWaStatus(el) {
  if (!el) return;
  try {
    const st = await api('GET', '/whatsapp/status');
    if (st.provider === 'manual') {
      el.innerHTML = `<div class="card wa-banner warn"><div><strong>WhatsApp não conectado.</strong> As cobranças estão sendo geradas, mas você precisa tocar em enviar em cada uma.
        <div class="small muted">Conecte seu número para as cobranças saírem sozinhas.</div></div><a class="btn wa" href="#/config">Conectar WhatsApp</a></div>`;
    } else if (!st.connected) {
      el.innerHTML = `<div class="card wa-banner danger"><div><strong>WhatsApp desconectado.</strong> As cobranças automáticas vão falhar até reconectar.
        <div class="small muted">${esc(st.error || st.detail || '')}</div></div><a class="btn wa" href="#/config">Reconectar</a></div>`;
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
    ${items.length ? `<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Empréstimo</th><th>Vencimento</th><th class="right">Parcela</th><th class="right">Devido</th><th>Situação</th><th></th></tr></thead>
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
    <div class="card">${list.length ? `<div class="table-wrap"><table><thead><tr><th>Nome</th><th>Telefone</th><th>Score</th><th class="right">Saldo devedor</th><th class="right">Em atraso</th></tr></thead><tbody>
      ${list.map((c) => `<tr class="click" data-id="${c.id}"><td><strong>${esc(c.name)}</strong>${c.tags ? `<div class="small muted">${esc(c.tags)}</div>` : ''}</td>
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

function clientDialog(c, onSaved) {
  c = c || { score: 3, whatsapp_opt_in: 1 };
  modal(c.id ? 'Editar cliente' : 'Novo cliente', `<form class="form-grid">
    <div class="field full"><label>Nome completo *</label><input name="name" value="${esc(c.name)}" required></div>
    <div class="field"><label>WhatsApp / Telefone</label><input name="phone" inputmode="tel" placeholder="(11) 99999-9999" value="${esc(c.phone)}"></div>
    <div class="field"><label>CPF / Documento</label><input name="document" value="${esc(c.document)}"></div>
    <div class="field"><label>E-mail</label><input type="email" name="email" value="${esc(c.email)}"></div>
    <div class="field"><label>Score (confiança)</label><select name="score">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${n == c.score ? 'selected' : ''}>${stars(n)}</option>`).join('')}</select></div>
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
    <div class="muted small">${esc(c.phone || 'sem telefone')} ${c.document ? '· ' + esc(c.document) : ''} · <span class="stars">${stars(c.score)}</span></div></div>
    <div class="actions">
      ${c.wa_link ? `<a class="btn wa" href="${esc(c.wa_link)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
      <button class="btn" id="send-msg">Enviar mensagem</button>
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
          <div class="summary-row"><span class="muted">E-mail</span><span>${esc(c.email || '—')}</span></div>
          <div class="summary-row"><span class="muted">Endereço</span><span>${esc(c.address || '—')}</span></div>
          <div class="summary-row"><span class="muted">Tags</span><span>${esc(c.tags || '—')}</span></div>
          <div class="summary-row"><span class="muted">WhatsApp</span><span>${c.whatsapp_opt_in ? 'Aceita mensagens' : 'Não enviar'}</span></div>
          ${c.notes ? `<div class="pre small" style="margin-top:8px">${esc(c.notes)}</div>` : ''}
          <div class="btn-row" style="margin-top:12px"><button class="btn sm" id="archive">${c.archived ? 'Desarquivar' : 'Arquivar'}</button>
          ${c.loans.length ? '' : '<button class="btn sm danger" id="del">Excluir</button>'}</div>
        </div>
        ${c.payments.length ? `<div class="card"><h2>Pagamentos</h2>${c.payments.slice(0, 15).map((p) => `<div class="list-item"><div class="main"><strong class="num">${brl(p.amount_cents)}</strong>
          <span class="small muted">${dateBR(p.paid_at)} · empréstimo #${p.loan_id} parcela ${p.number} · ${esc(p.method || '')}</span></div></div>`).join('')}</div>` : ''}
      </div>
      <div class="card"><h2>Histórico (CRM)</h2>
        <form id="note-form" style="display:flex;gap:8px;margin-bottom:14px"><input name="body" placeholder="Adicionar anotação (ligação, acordo, visita…)"><button class="btn">Salvar</button></form>
        <div class="timeline">${c.messages.length ? c.messages.map(msgBubble).join('') : '<div class="empty">Sem interações ainda</div>'}</div>
      </div>
    </div>`;
  $('#edit').onclick = () => clientDialog(c, reload);
  $('#send-msg').onclick = async () => messageDialog({ clientId: c.id, templates: await api('GET', '/templates'), onDone: reload });
  $('#archive').onclick = () => guard(async () => { await api('PUT', `/clients/${c.id}`, { archived: !c.archived }); reload(); });
  if ($('#del')) $('#del').onclick = async () => { if (await confirmDialog('Excluir este cliente definitivamente?', 'Excluir')) guard(async () => { await api('DELETE', `/clients/${c.id}`); go('/clientes'); }); };
  $('#note-form').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); guard(async () => { await api('POST', `/clients/${c.id}/notes`, f); reload(); }, e.submitter); };
  bindMessageActions(main, reload);
  refreshBadges();
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
    const list = await api('GET', `/messages?limit=1000`);
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
    <div class="card">${list.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Cliente</th><th>Data</th><th class="right">Emprestado</th><th>Condições</th><th>Progresso</th><th class="right">Saldo</th><th>Status</th></tr></thead><tbody>
    ${list.map((l) => `<tr class="click" data-id="${l.id}"><td>${l.id}</td><td><strong>${esc(l.client_name)}</strong></td><td class="nowrap">${dateBR(l.start_date)}</td>
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
  const today = todayISO();
  let mode = pre || query?.get?.('existente') ? 'existing' : 'new';
  main.innerHTML = `<div class="page-head"><div><a href="#/emprestimos" class="small">← Empréstimos</a><h1>Novo cliente / empréstimo</h1>
    <div class="muted small">Cadastre aqui o cliente já aprovado no WhatsApp. A partir daqui o app cuida das cobranças.</div></div></div>
    <div class="grid cols-2">
      <form class="card" id="loan-form">
        <div class="tabs" style="margin-top:-6px"><button type="button" data-mode="new">Cliente novo</button><button type="button" data-mode="existing">Cliente já cadastrado</button></div>
        <div class="form-grid" data-section="new">
          <div class="field full"><label>Nome completo *</label><input name="nc_name"></div>
          <div class="field"><label>WhatsApp *</label><input name="nc_phone" inputmode="tel" placeholder="(11) 99999-9999"></div>
          <div class="field"><label>CPF</label><input name="nc_document"></div>
          <div class="field full"><label>Endereço</label><input name="nc_address"></div>
          <div class="field full"><label>Observações sobre o cliente</label><input name="nc_notes" placeholder="ex.: indicado por…, trabalha em…"></div>
        </div>
        <div class="form-grid" data-section="existing">
          <div class="field full"><label>Cliente *</label><select name="client_id"><option value="">Selecione…</option>
          ${clients.map((c) => `<option value="${c.id}" ${c.id == pre ? 'selected' : ''}>${esc(c.name)}${c.phone ? ' · ' + esc(c.phone) : ''}</option>`).join('')}</select></div>
        </div>
        <h3 style="margin:8px 0 10px">Empréstimo</h3>
        <div class="form-grid">
        <div class="field"><label>Valor emprestado (R$) *</label><input name="principal" inputmode="decimal" placeholder="1.000,00" required></div>
        <div class="field"><label>Data do empréstimo</label><input type="date" name="start_date" value="${today}"></div>
        <div class="field"><label>Frequência das parcelas</label><select name="frequency">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="field"><label>Nº de parcelas</label><input type="number" name="installments_count" min="1" max="600" value="1"></div>
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
          <div class="table-wrap" style="margin-top:10px;max-height:420px;overflow:auto"><table><thead><tr><th>#</th><th>Vencimento</th><th class="right">Juros</th><th class="right">Amortização</th><th class="right">Parcela</th></tr></thead>
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
  form.onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      const p = payload();
      for (const k of Object.keys(p)) if (k.startsWith('nc_')) delete p[k];
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
    <div class="muted small">${dateBR(l.start_date)} · ${METHOD[l.method]} · ${String(l.interest_rate).replace('.', ',')}% ${FREQ_UNIT[l.frequency]} · ${l.installments_count}x ${FREQ[l.frequency].toLowerCase()}</div></div>
    <div class="actions"><button class="btn" id="edit-loan">Encargos/observações</button>
    ${l.status === 'active' ? '<button class="btn danger" id="cancel-loan">Cancelar</button>' : ''}
    <button class="btn danger" id="del-loan">Excluir</button></div></div>
    <div class="kpis">
      <div class="kpi"><div class="label">Emprestado</div><div class="value">${brl(l.principal_cents)}</div></div>
      <div class="kpi"><div class="label">Total contratado</div><div class="value">${brl(l.total_cents)}</div><div class="sub">juros ${brl(l.total_cents - l.principal_cents)}</div></div>
      <div class="kpi ok"><div class="label">Recebido</div><div class="value">${brl(l.paid_cents)}</div><div class="sub">${l.paid_count}/${l.installments_count} parcelas</div></div>
      <div class="kpi primary"><div class="label">Saldo devedor</div><div class="value">${brl(l.balance_cents)}</div>${l.overdue_cents ? `<div class="sub" style="color:var(--danger)">${brl(l.overdue_cents)} em atraso</div>` : ''}</div>
    </div>
    <div class="card"><h2>Parcelas</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Vencimento</th><th class="right">Valor</th><th class="right">Pago</th><th class="right">Devido hoje</th><th>Situação</th><th></th></tr></thead><tbody>
      ${items.map((i) => `<tr><td>${i.number}</td><td class="nowrap">${dateBR(i.due_date)}${i.paid_at ? `<div class="small muted">pago ${dateBR(i.paid_at)}</div>` : ''}</td>
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
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>${m.client_id ? `<a href="#/clientes/${m.client_id}">${esc(m.client_name)}</a>` : 'Desconhecido'}</strong>
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
  const [rules, templates, settings] = await Promise.all([api('GET', '/rules'), api('GET', '/templates'), api('GET', '/settings')]);
  const reload = () => pageAutomations(main);
  const ruleDesc = (r) => r.trigger === 'before_due' ? `${r.days} dia(s) antes` : r.trigger === 'on_due' ? 'no dia' : `${r.days} dia(s) após${r.repeat_every ? `, repete a cada ${r.repeat_every} dia(s)${r.max_repeats ? ` (até ${r.max_repeats}x)` : ''}` : ''}`;
  main.innerHTML = `<div class="page-head"><div><h1>Automações</h1><div class="muted small">
    ${settings.scheduler_enabled === '1' ? `✅ Ativas — verificação a cada ${settings.scheduler_interval_minutes} min, entre ${settings.send_window_start} e ${settings.send_window_end}` : '⏸ Automações pausadas (ative em Configurações)'}
    · WhatsApp: <strong>${{ manual: 'envio manual (wa.me)', cloud: 'WhatsApp Cloud API', evolution: 'Evolution API', zapi: 'Z-API', webhook: 'Webhook' }[settings.wa_provider]}</strong></div></div>
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
        <div class="card"><h2>Por forma de pagamento</h2>${Object.entries(r.by_method).map(([k, v]) => `<div class="summary-row"><span>${esc(k)}</span><strong class="num">${brl(v)}</strong></div>`).join('') || '<div class="empty">—</div>'}</div>
        <div class="card"><h2>Novos empréstimos</h2>${r.loans.length ? r.loans.map((l) => `<div class="summary-row"><span><a href="#/emprestimos/${l.id}">#${l.id}</a> ${esc(l.client_name)} · ${dateBR(l.start_date)}</span><strong class="num">${brl(l.principal_cents)}</strong></div>`).join('') : '<div class="empty">Nenhum</div>'}</div>
        <div class="card"><h2>Exportar planilhas (CSV)</h2><div class="btn-row">
          <a class="btn sm" href="/api/export/emprestimos.csv">Empréstimos</a><a class="btn sm" href="/api/export/parcelas.csv">Parcelas</a>
          <a class="btn sm" href="/api/export/pagamentos.csv">Pagamentos</a><a class="btn sm" href="/api/export/clientes.csv">Clientes</a></div>
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

// ---------- Configurações ----------
async function pageSettings(main) {
  const s = await api('GET', '/settings');
  const webhookUrl = `${location.origin}/api/webhooks/whatsapp/${s.wa_inbound_token}`;
  const reload = () => pageSettings(main);
  main.innerHTML = `<div class="page-head"><h1>Configurações</h1></div>
    <form id="settings-form">
    <div class="card"><h2>Negócio</h2><div class="form-grid">
      <div class="field"><label>Nome exibido nas mensagens</label><input name="business_name" value="${esc(s.business_name)}"></div>
      <div class="field"><label>Chave PIX</label><input name="pix_key" value="${esc(s.pix_key)}" placeholder="CPF, e-mail, telefone ou aleatória"></div>
      <div class="field"><label>Multa padrão por atraso (%)</label><input name="default_late_fee_percent" value="${esc(s.default_late_fee_percent)}"></div>
      <div class="field"><label>Juros de mora padrão (% ao dia)</label><input name="default_late_interest_daily" value="${esc(s.default_late_interest_daily)}"><div class="hint">0,033% ao dia ≈ 1% ao mês</div></div>
      <div class="field"><label>Fuso horário</label><input name="timezone" value="${esc(s.timezone)}"></div>
      <div class="field"><label>DDI padrão</label><input name="default_country_code" value="${esc(s.default_country_code)}"></div>
    </div></div>
    <div class="card"><h2>Automação de cobranças</h2><div class="form-grid">
      <div class="field full"><label class="check"><input type="checkbox" name="scheduler_enabled" ${s.scheduler_enabled === '1' ? 'checked' : ''}> Enviar avisos automaticamente conforme as regras</label></div>
      <div class="field"><label>Enviar a partir de</label><input type="time" name="send_window_start" value="${esc(s.send_window_start)}"></div>
      <div class="field"><label>Enviar até</label><input type="time" name="send_window_end" value="${esc(s.send_window_end)}"></div>
      <div class="field"><label>Verificar a cada (minutos)</label><input type="number" min="1" name="scheduler_interval_minutes" value="${esc(s.scheduler_interval_minutes)}"></div>
      <div class="field"><label class="check" style="margin-top:26px"><input type="checkbox" name="send_receipt_on_payment" ${s.send_receipt_on_payment === '1' ? 'checked' : ''}> Enviar recibo ao registrar pagamento</label></div>
      <div class="field full"><label class="check"><input type="checkbox" name="send_release_message" ${s.send_release_message === '1' ? 'checked' : ''}> Ao cadastrar um empréstimo, enviar a confirmação com as datas de cobrança</label></div>
    </div></div>
    <div class="card"><h2>WhatsApp — conexão</h2>
      <div id="wa-conn" class="wa-conn"><span class="muted small">Verificando conexão…</span></div>
      <div class="field"><label>Forma de envio</label><select name="wa_provider">
        <option value="evolution">Evolution API — conecta o seu número por QR Code (gratuita, auto-hospedada)</option>
        <option value="zapi">Z-API — conecta o seu número por QR Code (serviço pago)</option>
        <option value="cloud">WhatsApp Cloud API (oficial da Meta)</option>
        <option value="webhook">Meu CRM / automação (envia para uma URL: n8n, Make, CRM próprio…)</option>
        <option value="manual">Manual — abre o WhatsApp com a mensagem pronta (sem conexão)</option></select></div>
      <div data-prov="cloud" class="form-grid">
        <div class="field"><label>Token de acesso</label><input name="wa_cloud_token" value="${esc(s.wa_cloud_token)}" autocomplete="off"></div>
        <div class="field"><label>Phone Number ID</label><input name="wa_cloud_phone_id" value="${esc(s.wa_cloud_phone_id)}"></div>
        <div class="field"><label>Versão da API</label><input name="wa_cloud_api_version" value="${esc(s.wa_cloud_api_version)}"></div>
        <div class="hint full">Atenção: pela regra da Meta, mensagens livres só são entregues se o cliente falou com você nas últimas 24h. Fora disso é preciso usar modelos aprovados.</div>
      </div>
      <div data-prov="evolution" class="form-grid">
        <div class="field"><label>URL da API</label><input name="wa_evolution_url" value="${esc(s.wa_evolution_url)}" placeholder="https://evolution.seudominio.com"></div>
        <div class="field"><label>Nome da instância</label><input name="wa_evolution_instance" value="${esc(s.wa_evolution_instance)}"></div>
        <div class="field"><label>API Key</label><input name="wa_evolution_apikey" value="${esc(s.wa_evolution_apikey)}" autocomplete="off"></div>
      </div>
      <div data-prov="zapi" class="form-grid">
        <div class="field"><label>ID da instância</label><input name="wa_zapi_instance" value="${esc(s.wa_zapi_instance)}"></div>
        <div class="field"><label>Token da instância</label><input name="wa_zapi_token" value="${esc(s.wa_zapi_token)}" autocomplete="off"></div>
        <div class="field"><label>Client-Token (segurança)</label><input name="wa_zapi_client_token" value="${esc(s.wa_zapi_client_token)}" autocomplete="off"></div>
      </div>
      <div data-prov="webhook" class="form-grid">
        <div class="field full"><label>URL do seu CRM / automação</label><input name="wa_webhook_url" value="${esc(s.wa_webhook_url)}"><div class="hint">Cada cobrança é enviada como POST JSON <code>{"phone": "5511999999999", "message": "texto"}</code>. Seu CRM ou automação faz o envio no WhatsApp.</div></div>
      </div>
      <div data-prov="cloud evolution zapi" style="margin-top:6px">
        <label>Webhook de respostas (cole no seu provedor para receber mensagens dos clientes no CRM)</label>
        <div style="display:flex;gap:8px"><input readonly value="${esc(webhookUrl)}" id="wh"><button type="button" class="btn" id="copy-wh">Copiar</button></div>
        <div class="hint">Para a Cloud API, use também este token como “Verify token” (qualquer valor é aceito).</div>
      </div>
      <div class="btn-row" style="margin-top:12px"><input id="test-phone" placeholder="Telefone para teste" style="max-width:220px"><button type="button" class="btn" id="test-wa">Enviar teste</button></div>
    </div>
    <div class="card save-bar"><button class="btn primary">Salvar configurações</button></div>
    </form>
    <div class="grid cols-2" style="margin-top:16px">
      <form class="card" id="pw-form"><h2>Alterar senha</h2>
        <div class="field"><label>Senha atual</label><input type="password" name="current" required autocomplete="current-password"></div>
        <div class="field"><label>Nova senha</label><input type="password" name="password" required minlength="6" autocomplete="new-password"></div>
        <button class="btn">Alterar senha</button></form>
      <div class="card"><h2>Backup</h2><p class="small muted">Baixe uma cópia completa dos dados (clientes, empréstimos, pagamentos, mensagens). Guarde em local seguro.</p>
        <div class="btn-row"><a class="btn" href="/api/backup">⬇ Baixar backup</a><label class="btn" style="margin:0;color:var(--text)">⬆ Restaurar<input type="file" id="restore" accept="application/json" hidden></label></div></div>
    </div>`;
  const form = $('#settings-form');
  form.wa_provider.value = s.wa_provider;
  const syncProv = () => { for (const el of $$('[data-prov]', main)) el.style.display = el.dataset.prov.split(' ').includes(form.wa_provider.value) ? '' : 'none'; };
  form.wa_provider.onchange = syncProv; syncProv();
  const conn = async () => {
    const el = $('#wa-conn');
    if (!el) return;
    const st = await api('GET', '/whatsapp/status');
    const dot = st.provider === 'manual' ? 'warn' : st.connected ? 'ok' : 'danger';
    const label = st.provider === 'manual' ? 'Modo manual (sem conexão)' : st.connected ? 'Conectado — cobranças saem automaticamente' : 'Desconectado';
    el.innerHTML = `<span class="badge ${dot}">● ${label}</span> <span class="small muted">${esc(st.error || st.detail || '')}</span>
      ${st.can_qr || ['evolution', 'zapi'].includes(st.provider) ? `<button type="button" class="btn sm wa" id="wa-qr">${st.connected ? 'Reconectar' : 'Conectar com QR Code'}</button>` : ''}`;
    const qrBtn = $('#wa-qr');
    if (qrBtn) qrBtn.onclick = () => guard(async () => {
      const q = await api('POST', '/whatsapp/qr');
      if (q.connected) { toast(q.message); return conn(); }
      const close = modal('Conectar WhatsApp', `<div style="text-align:center"><p class="small">No celular: WhatsApp → <strong>Aparelhos conectados</strong> → <strong>Conectar um aparelho</strong> e aponte para o código.</p>
        <img src="${esc(q.image)}" alt="QR Code" style="width:280px;max-width:100%;background:#fff;padding:8px;border-radius:12px">
        ${q.pairing_code ? `<p class="small muted">Ou use o código de pareamento: <strong>${esc(q.pairing_code)}</strong></p>` : ''}
        <p class="small muted" id="qr-wait">Aguardando leitura…</p></div>`);
      const timer = setInterval(async () => {
        if (!$('#qr-wait')) return clearInterval(timer);
        const s2 = await api('GET', '/whatsapp/status').catch(() => ({}));
        if (s2.connected) { clearInterval(timer); close(); toast('WhatsApp conectado!'); conn(); }
      }, 3000);
    }, qrBtn);
  };
  conn().catch(() => {});
  $('#copy-wh').onclick = () => { navigator.clipboard?.writeText(webhookUrl); toast('Copiado'); };
  form.onsubmit = (e) => {
    e.preventDefault();
    const f = formData(form);
    for (const k of ['scheduler_enabled', 'send_receipt_on_payment', 'send_release_message']) f[k] = f[k] ? '1' : '0';
    for (const k of ['default_late_fee_percent', 'default_late_interest_daily']) f[k] = String(f[k]).replace(',', '.');
    guard(async () => { await api('PUT', '/settings', f); toast('Configurações salvas'); $('#brand-name').textContent = f.business_name; reload(); }, e.submitter);
  };
  $('#test-wa').onclick = (e) => guard(async () => {
    const f = formData(form);
    for (const k of ['scheduler_enabled', 'send_receipt_on_payment', 'send_release_message']) f[k] = f[k] ? '1' : '0';
    await api('PUT', '/settings', f);
    const phone = $('#test-phone').value;
    const r = await api('POST', '/settings/test-whatsapp', { phone });
    if (r.status === 'pending_manual') { openWa(`https://wa.me/${phone.replace(/\D/g, '').replace(/^(?!55)/, s.default_country_code)}?text=${encodeURIComponent('Teste de envio')}`); toast('Modo manual: WhatsApp aberto'); } else toast('Mensagem de teste enviada!');
  }, e.target);
  $('#pw-form').onsubmit = (e) => { e.preventDefault(); guard(async () => { await api('POST', '/auth/password', formData(e.target)); e.target.reset(); toast('Senha alterada'); }, e.submitter); };
  $('#restore').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!(await confirmDialog('Restaurar o backup vai SUBSTITUIR todos os dados atuais. Continuar?', 'Restaurar'))) return;
    guard(async () => { await api('POST', '/restore', JSON.parse(await file.text())); toast('Backup restaurado'); start(); });
  };
}
