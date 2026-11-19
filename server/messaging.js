'use strict';
const { getSettings } = require('./db');
const F = require('./finance');

function normalizePhone(phone, cc = '55') {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length <= 11) d = cc + d.replace(/^0+/, '');
  return d;
}

function waLink(phone, text, cc) {
  const p = normalizePhone(phone, cc);
  return `https://wa.me/${p}?text=${encodeURIComponent(text || '')}`;
}

/** Saldo devedor atual do empréstimo (soma do restante das parcelas em aberto). */
function loanBalance(db, loan, refDate) {
  const insts = db.prepare("SELECT * FROM installments WHERE loan_id=? AND status='open'").all(loan.id);
  return insts.reduce((s, i) => s + F.installmentState(i, loan, refDate).remaining_cents, 0);
}

/** Monta o contexto de variáveis para os modelos de mensagem. */
function buildContext(db, { client, loan, installment, extra = {} }) {
  const s = getSettings(db);
  const today = F.todayIn(s.timezone);
  const ctx = {
    nome: client?.name || '',
    primeiro_nome: (client?.name || '').split(/\s+/)[0] || '',
    telefone: client?.phone || '',
    empresa: s.business_name || '',
    pix: s.pix_key || '(consulte-nos)',
    hoje: F.formatDateBR(today),
  };
  if (loan) {
    ctx.valor_emprestado = F.formatBRL(loan.principal_cents);
    ctx.total_emprestimo = F.formatBRL(loan.total_cents);
    ctx.qtd_parcelas = String(loan.installments_count);
    ctx.saldo_devedor = F.formatBRL(loanBalance(db, loan, today));
    ctx.cronograma = db.prepare("SELECT * FROM installments WHERE loan_id=? AND status!='canceled' ORDER BY number").all(loan.id)
      .map((i) => `${i.number}/${loan.installments_count} – ${F.formatDateBR(i.due_date)} – ${F.formatBRL(i.amount_cents)}`).join('\n');
  }
  if (installment && loan) {
    const st = F.installmentState(installment, loan, today);
    ctx.parcela = `${installment.number}/${loan.installments_count}`;
    ctx.valor = F.formatBRL(installment.amount_cents);
    ctx.valor_atualizado = F.formatBRL(st.status === 'open' ? st.remaining_cents : st.updated_amount_cents);
    ctx.vencimento = F.formatDateBR(installment.due_date);
    ctx.dias_atraso = String(st.days_late);
    ctx.dias_para_vencer = String(Math.max(0, F.diffDays(today, installment.due_date)));
  }
  return { ...ctx, ...extra };
}

function render(body, ctx) {
  return String(body).replace(/\{(\w+)\}/g, (m, k) => (k in ctx ? ctx[k] : m));
}

async function postJSON(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object' ? JSON.stringify(data) : String(data);
    throw new Error(`HTTP ${res.status}: ${msg.slice(0, 300)}`);
  }
  return data;
}

/** Envia texto pelo provedor configurado. Retorna { status, providerId }. */
async function sendWhatsApp(settings, phone, text) {
  const provider = settings.wa_provider || 'manual';
  const number = normalizePhone(phone, settings.default_country_code);
  if (!number) throw new Error('Cliente sem telefone cadastrado');

  switch (provider) {
    case 'manual':
      return { status: 'pending_manual' };
    case 'cloud': {
      if (!settings.wa_cloud_token || !settings.wa_cloud_phone_id) throw new Error('WhatsApp Cloud API não configurada');
      const v = settings.wa_cloud_api_version || 'v21.0';
      const data = await postJSON(`https://graph.facebook.com/${v}/${settings.wa_cloud_phone_id}/messages`, {
        messaging_product: 'whatsapp', to: number, type: 'text', text: { body: text, preview_url: false },
      }, { Authorization: `Bearer ${settings.wa_cloud_token}` });
      return { status: 'sent', providerId: data?.messages?.[0]?.id };
    }
    case 'evolution': {
      if (!settings.wa_evolution_url || !settings.wa_evolution_instance) throw new Error('Evolution API não configurada');
      const base = settings.wa_evolution_url.replace(/\/+$/, '');
      const data = await postJSON(`${base}/message/sendText/${encodeURIComponent(settings.wa_evolution_instance)}`,
        { number, text }, { apikey: settings.wa_evolution_apikey });
      return { status: 'sent', providerId: data?.key?.id };
    }
    case 'zapi': {
      if (!settings.wa_zapi_instance || !settings.wa_zapi_token) throw new Error('Z-API não configurada');
      const headers = settings.wa_zapi_client_token ? { 'Client-Token': settings.wa_zapi_client_token } : {};
      const data = await postJSON(`https://api.z-api.io/instances/${settings.wa_zapi_instance}/token/${settings.wa_zapi_token}/send-text`,
        { phone: number, message: text }, headers);
      return { status: 'sent', providerId: data?.messageId || data?.id };
    }
    case 'webhook': {
      if (!settings.wa_webhook_url) throw new Error('URL do webhook não configurada');
      const data = await postJSON(settings.wa_webhook_url, { phone: number, message: text });
      return { status: 'sent', providerId: data?.id ? String(data.id) : undefined };
    }
    default:
      throw new Error('Provedor de WhatsApp desconhecido: ' + provider);
  }
}

/**
 * Registra (e, se WhatsApp, envia) uma mensagem.
 * Retorna o registro salvo ou null se já existia (dedupe).
 */
async function dispatch(db, { client, loanId = null, installmentId = null, ruleId = null, dedupeKey = null, channel, kind, body }) {
  if (dedupeKey && db.prepare('SELECT 1 FROM messages WHERE dedupe_key=?').get(dedupeKey)) return null;
  const settings = getSettings(db);

  let status = 'logged', error = null, providerId = null, sentAt = null;
  if (channel === 'whatsapp') {
    if (!client.whatsapp_opt_in) {
      status = 'failed'; error = 'Cliente não autorizou mensagens no WhatsApp';
    } else {
      try {
        const r = await sendWhatsApp(settings, client.phone, body);
        status = r.status; providerId = r.providerId || null;
        if (status === 'sent') sentAt = new Date().toISOString();
      } catch (e) {
        status = 'failed'; error = e.message;
      }
    }
  }

  let info;
  try {
    info = db.prepare(`INSERT INTO messages(client_id, loan_id, installment_id, rule_id, dedupe_key, direction, channel, kind, body, status, error, provider_id, sent_at)
      VALUES (?,?,?,?,?,'out',?,?,?,?,?,?,?)`)
      .run(client.id, loanId, installmentId, ruleId, dedupeKey, channel, kind, body, status, error, providerId, sentAt);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return null;
    throw e;
  }
  return db.prepare('SELECT * FROM messages WHERE id=?').get(Number(info.lastInsertRowid));
}

/** Tenta extrair { phone, text, id } de payloads comuns de webhooks (Cloud API, Evolution, Z-API). */
function parseInbound(payload) {
  const out = [];
  try {
    // Meta Cloud API
    for (const entry of payload?.entry || []) {
      for (const ch of entry.changes || []) {
        for (const m of ch.value?.messages || []) {
          out.push({ phone: m.from, text: m.text?.body || m.button?.text || `[${m.type}]`, id: m.id });
        }
      }
    }
    // Evolution API (messages.upsert)
    const d = payload?.data;
    if (d?.key?.remoteJid && !d.key.fromMe && !d.key.remoteJid.endsWith('@g.us')) {
      const text = d.message?.conversation || d.message?.extendedTextMessage?.text || '[mídia]';
      out.push({ phone: d.key.remoteJid.split('@')[0], text, id: d.key.id });
    }
    // Z-API
    if (payload?.phone && payload?.fromMe === false && !payload.isGroup) {
      out.push({ phone: payload.phone, text: payload.text?.message || '[mídia]', id: payload.messageId });
    }
  } catch { /* ignora formato desconhecido */ }
  return out;
}

function findClientByPhone(db, phone) {
  const digits = String(phone).replace(/\D/g, '');
  const tail = digits.slice(-8);
  const candidates = db.prepare("SELECT * FROM clients WHERE replace(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''),'+','') LIKE ?").all('%' + tail);
  return candidates[0] || null;
}

function evoBase(s) {
  if (!s.wa_evolution_url || !s.wa_evolution_instance) throw new Error('Preencha URL, instância e API key da Evolution API');
  return { base: s.wa_evolution_url.replace(/\/+$/, ''), inst: encodeURIComponent(s.wa_evolution_instance), headers: { apikey: s.wa_evolution_apikey } };
}
function zapiBase(s) {
  if (!s.wa_zapi_instance || !s.wa_zapi_token) throw new Error('Preencha o ID e o token da instância Z-API');
  return { base: `https://api.z-api.io/instances/${s.wa_zapi_instance}/token/${s.wa_zapi_token}`, headers: s.wa_zapi_client_token ? { 'Client-Token': s.wa_zapi_client_token } : {} };
}
async function getJSON(url, headers, method = 'GET', body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(typeof data === 'object' ? JSON.stringify(data) : String(data)).slice(0, 300)}`);
  return data;
}

/** Status da conexão do número de WhatsApp com o provedor. */
async function connectionStatus(s) {
  switch (s.wa_provider) {
    case 'manual': return { provider: 'manual', connected: false, automatic: false, detail: 'Envio manual: você toca em enviar em cada mensagem.' };
    case 'evolution': {
      const { base, inst, headers } = evoBase(s);
      const d = await getJSON(`${base}/instance/connectionState/${inst}`, headers);
      const state = d?.instance?.state || d?.state;
      return { provider: 'evolution', connected: state === 'open', automatic: true, detail: `Estado: ${state || 'desconhecido'}`, can_qr: true };
    }
    case 'zapi': {
      const { base, headers } = zapiBase(s);
      const d = await getJSON(`${base}/status`, headers);
      return { provider: 'zapi', connected: !!d?.connected, automatic: true, detail: d?.error || (d?.connected ? 'Conectado' : 'Desconectado'), can_qr: true };
    }
    case 'cloud':
      if (!s.wa_cloud_token || !s.wa_cloud_phone_id) throw new Error('Preencha token e Phone Number ID');
      await getJSON(`https://graph.facebook.com/${s.wa_cloud_api_version || 'v21.0'}/${s.wa_cloud_phone_id}`, { Authorization: `Bearer ${s.wa_cloud_token}` });
      return { provider: 'cloud', connected: true, automatic: true, detail: 'Credenciais válidas' };
    case 'webhook':
      return { provider: 'webhook', connected: !!s.wa_webhook_url, automatic: true, detail: s.wa_webhook_url ? 'Enviando para o seu CRM/automação' : 'Informe a URL' };
    default: return { provider: s.wa_provider, connected: false, automatic: false, detail: 'Provedor desconhecido' };
  }
}

/** Obtém o QR Code para conectar o número (Evolution API / Z-API). */
async function connectionQR(s) {
  if (s.wa_provider === 'evolution') {
    const { base, inst, headers } = evoBase(s);
    let d;
    try {
      d = await getJSON(`${base}/instance/connect/${inst}`, headers);
    } catch (e) {
      if (!/404/.test(e.message)) throw e;
      // instância ainda não existe: cria e pede o QR
      d = await getJSON(`${base}/instance/create`, headers, 'POST', { instanceName: s.wa_evolution_instance, integration: 'WHATSAPP-BAILEYS', qrcode: true });
      d = d?.qrcode || d;
    }
    const img = d?.base64 || d?.qrcode?.base64;
    if (!img) return { connected: true, message: 'Número já conectado' };
    return { image: img.startsWith('data:') ? img : `data:image/png;base64,${img}`, pairing_code: d?.pairingCode || null };
  }
  if (s.wa_provider === 'zapi') {
    const { base, headers } = zapiBase(s);
    const d = await getJSON(`${base}/qr-code/image`, headers);
    if (d?.connected) return { connected: true, message: 'Número já conectado' };
    const img = d?.value || d?.image;
    if (!img) throw new Error('A Z-API não retornou o QR Code');
    return { image: img.startsWith('data:') ? img : `data:image/png;base64,${img}` };
  }
  throw new Error('QR Code disponível apenas para Evolution API e Z-API');
}

module.exports = { connectionStatus, connectionQR, normalizePhone, waLink, buildContext, render, sendWhatsApp, dispatch, parseInbound, findClientByPhone, loanBalance };
