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
    documentos: String(s.required_documents || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => '• ' + l).join('\n'),
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
        const names = Object.fromEntries((ch.value?.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of ch.value?.messages || []) {
          out.push({ phone: m.from, name: names[m.from], text: m.text?.body || m.button?.text || m.interactive?.button_reply?.title || `[${m.type}]`, id: m.id });
        }
      }
    }
    // Evolution API (messages.upsert)
    const d = payload?.data;
    if (d?.key?.remoteJid && !d.key.fromMe && !d.key.remoteJid.endsWith('@g.us')) {
      const msg = d.message || {};
      const text = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || (msg.imageMessage ? '[imagem]' : msg.documentMessage ? `[documento] ${msg.documentMessage.fileName || ''}` : msg.audioMessage ? '[áudio]' : '[mídia]');
      out.push({ phone: d.key.remoteJid.split('@')[0], name: d.pushName, text, id: d.key.id });
    }
    // Z-API
    if (payload?.phone && payload?.fromMe === false && !payload.isGroup) {
      const text = payload.text?.message || payload.image?.caption || (payload.image ? '[imagem]' : payload.document ? `[documento] ${payload.document.fileName || ''}` : payload.audio ? '[áudio]' : '[mídia]');
      out.push({ phone: payload.phone, name: payload.senderName || payload.chatName, text, id: payload.messageId });
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

/**
 * Processa uma mensagem recebida: cria o contato como "novo pedido" se for desconhecido
 * e responde automaticamente (bot) quando ativado.
 */
async function handleInbound(db, m) {
  const s = getSettings(db);
  let client = findClientByPhone(db, m.phone);
  let isNew = false;
  if (!client) {
    const r = db.prepare("INSERT INTO clients(name, phone, stage, source, stage_updated_at) VALUES (?,?,'lead','whatsapp',datetime('now'))")
      .run((m.name || '').trim() || `Contato ${m.phone}`, m.phone);
    client = db.prepare('SELECT * FROM clients WHERE id=?').get(Number(r.lastInsertRowid));
    isNew = true;
  }
  try {
    db.prepare(`INSERT INTO messages(client_id, dedupe_key, direction, channel, kind, body, status, provider_id)
      VALUES (?,?,'in','whatsapp','inbound',?,'received',?)`).run(client.id, m.id ? `in:${m.id}` : null, m.text, m.id || null);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return { client, duplicate: true };
    throw e;
  }

  const reply = botReply(db, s, client, m.text, isNew);
  if (reply && s.bot_enabled === '1' && s.wa_provider !== 'manual') {
    await dispatch(db, { client, channel: 'whatsapp', kind: 'bot', body: reply });
  }
  return { client, isNew, reply };
}

function botReply(db, s, client, text, isNew) {
  const ctx = buildContext(db, { client });
  if (isNew) return s.bot_new_contact_enabled === '1' ? render(s.bot_welcome, ctx) : null;
  if (client.stage !== 'client') return null; // pedidos em análise: atendimento humano
  const t = String(text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const today = F.todayIn(s.timezone);
  const next = db.prepare(`SELECT i.*, l.late_fee_percent, l.late_interest_daily, l.installments_count FROM installments i JOIN loans l ON l.id=i.loan_id
    WHERE l.client_id=? AND l.status='active' AND i.status='open' ORDER BY i.due_date LIMIT 1`).get(client.id);
  if (t === '1' || /\b(parcela|vencimento|vence|boleto)\b/.test(t)) {
    if (!next) return `${ctx.primeiro_nome}, você não possui parcelas em aberto. 👍`;
    const st = F.installmentState(next, next, today);
    return `Sua próxima parcela (${next.number}/${next.installments_count}) vence em ${F.formatDateBR(next.due_date)}.\nValor: ${F.formatBRL(st.remaining_cents)}${st.days_late ? ` (com encargos de ${st.days_late} dia(s) de atraso)` : ''}.\n\nPIX: ${ctx.pix}`;
  }
  if (t === '2' || /\b(saldo|quanto devo|divida|quitar|quitacao)\b/.test(t)) {
    const loans = db.prepare("SELECT * FROM loans WHERE client_id=? AND status='active'").all(client.id);
    const total = loans.reduce((acc, l) => acc + loanBalance(db, l, today), 0);
    return total ? `Seu saldo devedor atual é de ${F.formatBRL(total)}.` : 'Você não possui saldo devedor. 👍';
  }
  if (t === '3' || /\bpix\b/.test(t)) return `Chave PIX: ${ctx.pix}\nApós pagar, envie o comprovante por aqui.`;
  if (t === '4' || /\b(atendente|humano|pessoa|falar com)\b/.test(t)) return render(s.bot_human_reply, ctx);
  if (/^(menu|oi+|ola|opa|bom dia|boa tarde|boa noite|ajuda)\b/.test(t)) return render(s.bot_menu, ctx);
  return null;
}

module.exports = { handleInbound, botReply, normalizePhone, waLink, buildContext, render, sendWhatsApp, dispatch, parseInbound, findClientByPhone, loanBalance };
