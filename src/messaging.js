'use strict';
const { accountSettings, randomToken } = require('./db');
const F = require('./finance');

function normalizePhone(phone, cc = '55') {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length <= 11) d = cc + d.replace(/^0+/, '');
  return d;
}

const phoneTail = (p) => String(p || '').replace(/\D/g, '').slice(-8);

function waLink(phone, text, cc) {
  return `https://wa.me/${normalizePhone(phone, cc)}?text=${encodeURIComponent(text || '')}`;
}

function render(body, ctx) {
  return String(body || '').replace(/\{(\w+)\}/g, (m, k) => (k in ctx ? ctx[k] : m));
}

/** URL pública do site (para links de cadastro). */
function siteUrl(fallback) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (fallback) return fallback.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'http://localhost:3000';
}
const applicationLink = (token, base) => `${siteUrl(base)}/cadastro.html?t=${token}`;

async function loanBalance(db, loan, refDate) {
  const insts = await db.query("SELECT * FROM installments WHERE loan_id=$1 AND status='open'", [loan.id]);
  return insts.reduce((s, i) => s + F.installmentState(i, loan, refDate).remaining_cents, 0);
}

/** Variáveis disponíveis nos modelos de mensagem. */
async function buildContext(db, { settings, client, loan, installment, application, extra = {}, baseUrl }) {
  const s = settings;
  const today = F.todayIn(s.timezone);
  const person = client || application || {};
  const ctx = {
    nome: person.name || '',
    primeiro_nome: (person.name || '').split(/\s+/)[0] || '',
    telefone: person.phone || '',
    empresa: s.business_name || '',
    pix: s.pix_key || '(consulte-nos)',
    hoje: F.formatDateBR(today),
  };
  if (application) ctx.link = applicationLink(application.token, baseUrl);
  if (loan) {
    ctx.valor_emprestado = F.formatBRL(loan.principal_cents);
    ctx.total_emprestimo = F.formatBRL(loan.total_cents);
    ctx.qtd_parcelas = String(loan.installments_count);
    ctx.saldo_devedor = F.formatBRL(await loanBalance(db, loan, today));
    const insts = await db.query("SELECT * FROM installments WHERE loan_id=$1 AND status<>'canceled' ORDER BY number", [loan.id]);
    ctx.cronograma = insts.map((i) => `${i.number}/${loan.installments_count} – ${F.formatDateBR(i.due_date)} – ${F.formatBRL(i.amount_cents)}`).join('\n');
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

async function requestJSON(url, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(typeof data === 'object' ? JSON.stringify(data) : String(data)).slice(0, 300)}`);
  return data;
}

function evo(s) {
  if (!s.wa_evolution_url || !s.wa_evolution_instance) throw new Error('Preencha URL, instância e API key da Evolution API');
  return { base: s.wa_evolution_url.replace(/\/+$/, ''), inst: encodeURIComponent(s.wa_evolution_instance), headers: { apikey: s.wa_evolution_apikey } };
}
function zapi(s) {
  if (!s.wa_zapi_instance || !s.wa_zapi_token) throw new Error('Preencha o ID e o token da instância Z-API');
  return { base: `https://api.z-api.io/instances/${s.wa_zapi_instance}/token/${s.wa_zapi_token}`, headers: s.wa_zapi_client_token ? { 'Client-Token': s.wa_zapi_client_token } : {} };
}

/** Envia texto pelo provedor configurado na conta. */
async function sendWhatsApp(s, phone, text) {
  const number = normalizePhone(phone, s.default_country_code);
  if (!number) throw new Error('Sem telefone cadastrado');
  switch (s.wa_provider || 'manual') {
    case 'manual':
      return { status: 'pending_manual' };
    case 'cloud': {
      if (!s.wa_cloud_token || !s.wa_cloud_phone_id) throw new Error('WhatsApp Cloud API não configurada');
      const d = await requestJSON(`https://graph.facebook.com/${s.wa_cloud_api_version || 'v21.0'}/${s.wa_cloud_phone_id}/messages`, {
        body: { messaging_product: 'whatsapp', to: number, type: 'text', text: { body: text, preview_url: true } },
        headers: { Authorization: `Bearer ${s.wa_cloud_token}` },
      });
      return { status: 'sent', providerId: d?.messages?.[0]?.id };
    }
    case 'evolution': {
      const { base, inst, headers } = evo(s);
      const d = await requestJSON(`${base}/message/sendText/${inst}`, { body: { number, text }, headers });
      return { status: 'sent', providerId: d?.key?.id };
    }
    case 'zapi': {
      const { base, headers } = zapi(s);
      const d = await requestJSON(`${base}/send-text`, { body: { phone: number, message: text }, headers });
      return { status: 'sent', providerId: d?.messageId || d?.id };
    }
    case 'webhook': {
      if (!s.wa_webhook_url) throw new Error('URL do CRM/automação não configurada');
      const d = await requestJSON(s.wa_webhook_url, { body: { phone: number, message: text, account_id: s.owner_id } });
      return { status: 'sent', providerId: d?.id ? String(d.id) : undefined };
    }
    default:
      throw new Error('Provedor de WhatsApp desconhecido');
  }
}

/**
 * Registra e envia (se WhatsApp) uma mensagem da conta ownerId.
 * Retorna o registro, ou null se a mesma mensagem (dedupeKey) já existia.
 */
async function dispatch(db, { ownerId, client = null, application = null, phone = null, loanId = null, installmentId = null, ruleId = null, dedupeKey = null, channel = 'whatsapp', kind, body, settings }) {
  if (dedupeKey && await db.one('SELECT 1 FROM messages WHERE dedupe_key=$1', [dedupeKey])) return null;
  const s = settings || await accountSettings(db, ownerId);
  const to = phone || client?.phone || application?.phone;
  let status = 'logged', error = null, providerId = null, sentAt = null;
  if (channel === 'whatsapp') {
    if (client && !client.whatsapp_opt_in) {
      status = 'failed'; error = 'Cliente não autorizou mensagens no WhatsApp';
    } else {
      try {
        const r = await sendWhatsApp(s, to, body);
        status = r.status; providerId = r.providerId || null;
        if (status === 'sent') sentAt = new Date().toISOString();
      } catch (e) { status = 'failed'; error = e.message; }
    }
  }
  try {
    return await db.one(`INSERT INTO messages(owner_id, client_id, application_id, loan_id, installment_id, rule_id, dedupe_key, direction, channel, kind, phone, body, status, error, provider_id, sent_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'out',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [ownerId, client?.id || null, application?.id || null, loanId, installmentId, ruleId, dedupeKey, channel, kind, to || null, body, status, error, providerId, sentAt]);
  } catch (e) {
    if (/duplicate key|unique/i.test(e.message)) return null;
    throw e;
  }
}

/** Extrai mensagens de payloads de webhook (Cloud API, Evolution, Z-API). Ignora grupos e mensagens enviadas por você. */
function parseInbound(payload) {
  const out = [];
  try {
    for (const entry of payload?.entry || []) {
      for (const ch of entry.changes || []) {
        const names = Object.fromEntries((ch.value?.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of ch.value?.messages || []) {
          out.push({ phone: m.from, name: names[m.from], text: m.text?.body || m.button?.text || m.interactive?.button_reply?.title || `[${m.type}]`, id: m.id });
        }
      }
    }
    const d = payload?.data;
    if (d?.key?.remoteJid && !d.key.fromMe && !String(d.key.remoteJid).endsWith('@g.us')) {
      const msg = d.message || {};
      const text = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || (msg.imageMessage ? '[imagem]' : msg.documentMessage ? '[documento]' : msg.audioMessage ? '[áudio]' : msg.videoMessage ? '[vídeo]' : '[mídia]');
      out.push({ phone: String(d.key.remoteJid).split('@')[0], name: d.pushName, text, id: d.key.id });
    }
    if (payload?.phone && payload?.fromMe === false && !payload.isGroup) {
      const text = payload.text?.message || payload.image?.caption || (payload.image ? '[imagem]' : payload.document ? '[documento]' : payload.audio ? '[áudio]' : payload.video ? '[vídeo]' : '[mídia]');
      out.push({ phone: payload.phone, name: payload.senderName || payload.chatName, text, id: payload.messageId });
    }
  } catch { /* formato desconhecido */ }
  return out;
}

/**
 * Mensagem recebida no WhatsApp de uma conta.
 * - Cliente existente → registra no histórico e responde o menu do bot.
 * - Cadastro em andamento → registra e reenvia o link / avisa que está em análise.
 * - Número novo → cria um cadastro e envia o link para a pessoa preencher e mandar os documentos.
 */
async function handleInbound(db, owner, m, baseUrl) {
  const s = await accountSettings(db, owner.id);
  const tail = phoneTail(m.phone);
  const digits = "regexp_replace(COALESCE(phone,''), '\\D', '', 'g')";
  const client = await db.one(`SELECT * FROM clients WHERE owner_id=$1 AND ${digits} LIKE $2 ORDER BY archived, id DESC LIMIT 1`, [owner.id, '%' + tail]);
  let application = client ? null : await db.one(`SELECT * FROM applications WHERE owner_id=$1 AND ${digits} LIKE $2 AND status IN ('pending','needs_changes','submitted') ORDER BY id DESC LIMIT 1`, [owner.id, '%' + tail]);
  let isNew = false;
  if (!client && !application && s.bot_new_contact === '1') {
    application = await db.one(`INSERT INTO applications(owner_id, token, source, phone, name) VALUES ($1,$2,'whatsapp',$3,$4) RETURNING *`,
      [owner.id, randomToken(16), m.phone, (m.name || '').trim() || null]);
    isNew = true;
  }
  try {
    await db.query(`INSERT INTO messages(owner_id, client_id, application_id, dedupe_key, direction, channel, kind, phone, body, status, provider_id)
      VALUES ($1,$2,$3,$4,'in','whatsapp','inbound',$5,$6,'received',$7)`,
    [owner.id, client?.id || null, application?.id || null, m.id ? `in:${owner.id}:${m.id}` : null, m.phone, m.text, m.id || null]);
  } catch (e) {
    if (/duplicate key|unique/i.test(e.message)) return { duplicate: true };
    throw e;
  }
  if (s.bot_enabled !== '1') return { client, application, isNew };

  const reply = await botReply(db, s, { client, application, isNew, text: m.text, baseUrl });
  if (reply) await dispatch(db, { ownerId: owner.id, client, application, phone: m.phone, channel: 'whatsapp', kind: 'bot', body: reply, settings: s });
  return { client, application, isNew, reply };
}

async function botReply(db, s, { client, application, isNew, text, baseUrl }) {
  if (application) {
    const ctx = await buildContext(db, { settings: s, application, baseUrl });
    if (isNew) return render(s.bot_welcome, ctx);
    if (application.status === 'submitted') return render(s.bot_in_review, ctx);
    return render(s.bot_pending, ctx);
  }
  if (!client) return null;
  const ctx = await buildContext(db, { settings: s, client });
  const t = String(text || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const today = F.todayIn(s.timezone);
  if (t === '1' || /\b(parcela|vencimento|vence|boleto)\b/.test(t)) {
    const next = await db.one(`SELECT i.*, l.late_fee_percent, l.late_interest_daily, l.installments_count FROM installments i JOIN loans l ON l.id=i.loan_id
      WHERE l.client_id=$1 AND l.status='active' AND i.status='open' ORDER BY i.due_date LIMIT 1`, [client.id]);
    if (!next) return `${ctx.primeiro_nome}, você não possui parcelas em aberto. 👍`;
    const st = F.installmentState(next, next, today);
    return `Sua próxima parcela (${next.number}/${next.installments_count}) vence em ${F.formatDateBR(next.due_date)}.\nValor: ${F.formatBRL(st.remaining_cents)}${st.days_late ? ` (com encargos de ${st.days_late} dia(s) de atraso)` : ''}.\n\nPIX: ${ctx.pix}`;
  }
  if (t === '2' || /\b(saldo|quanto devo|divida|quitar|quitacao)\b/.test(t)) {
    const loans = await db.query("SELECT * FROM loans WHERE client_id=$1 AND status='active'", [client.id]);
    let total = 0;
    for (const l of loans) total += await loanBalance(db, l, today);
    return total ? `Seu saldo devedor atual é de ${F.formatBRL(total)}.` : 'Você não possui saldo devedor. 👍';
  }
  if (t === '3' || /\bpix\b/.test(t)) return `Chave PIX: ${ctx.pix}\nApós pagar, envie o comprovante por aqui.`;
  if (t === '4' || /\b(atendente|humano|pessoa|falar com)\b/.test(t)) return render(s.bot_human_reply, ctx);
  if (/^(menu|oi+|ola|opa|bom dia|boa tarde|boa noite|ajuda)\b/.test(t)) return render(s.bot_menu, ctx);
  return null;
}

/** Status da conexão do número da conta. */
async function connectionStatus(s) {
  switch (s.wa_provider) {
    case 'manual': return { provider: 'manual', connected: false, automatic: false, detail: 'Envio manual: você toca em enviar em cada mensagem.' };
    case 'evolution': {
      const { base, inst, headers } = evo(s);
      const d = await requestJSON(`${base}/instance/connectionState/${inst}`, { method: 'GET', headers });
      const state = d?.instance?.state || d?.state;
      return { provider: 'evolution', connected: state === 'open', automatic: true, detail: `Estado: ${state || 'desconhecido'}`, can_qr: true };
    }
    case 'zapi': {
      const { base, headers } = zapi(s);
      const d = await requestJSON(`${base}/status`, { method: 'GET', headers });
      return { provider: 'zapi', connected: !!d?.connected, automatic: true, detail: d?.error || (d?.connected ? 'Conectado' : 'Desconectado'), can_qr: true };
    }
    case 'cloud':
      if (!s.wa_cloud_token || !s.wa_cloud_phone_id) throw new Error('Preencha token e Phone Number ID');
      await requestJSON(`https://graph.facebook.com/${s.wa_cloud_api_version || 'v21.0'}/${s.wa_cloud_phone_id}`, { method: 'GET', headers: { Authorization: `Bearer ${s.wa_cloud_token}` } });
      return { provider: 'cloud', connected: true, automatic: true, detail: 'Credenciais válidas' };
    case 'webhook':
      return { provider: 'webhook', connected: !!s.wa_webhook_url, automatic: true, detail: s.wa_webhook_url ? 'Enviando para o seu CRM/automação' : 'Informe a URL' };
    default: return { provider: s.wa_provider, connected: false, automatic: false, detail: 'Provedor desconhecido' };
  }
}

/** QR Code para conectar o número (Evolution API / Z-API). */
async function connectionQR(s) {
  if (s.wa_provider === 'evolution') {
    const { base, inst, headers } = evo(s);
    let d;
    try {
      d = await requestJSON(`${base}/instance/connect/${inst}`, { method: 'GET', headers });
    } catch (e) {
      if (!/404/.test(e.message)) throw e;
      d = await requestJSON(`${base}/instance/create`, { headers, body: { instanceName: s.wa_evolution_instance, integration: 'WHATSAPP-BAILEYS', qrcode: true } });
      d = d?.qrcode || d;
    }
    const img = d?.base64 || d?.qrcode?.base64;
    if (!img) return { connected: true, message: 'Número já conectado' };
    return { image: img.startsWith('data:') ? img : `data:image/png;base64,${img}`, pairing_code: d?.pairingCode || null };
  }
  if (s.wa_provider === 'zapi') {
    const { base, headers } = zapi(s);
    const d = await requestJSON(`${base}/qr-code/image`, { method: 'GET', headers });
    if (d?.connected) return { connected: true, message: 'Número já conectado' };
    const img = d?.value || d?.image;
    if (!img) throw new Error('A Z-API não retornou o QR Code');
    return { image: img.startsWith('data:') ? img : `data:image/png;base64,${img}` };
  }
  throw new Error('QR Code disponível apenas para Evolution API e Z-API');
}

module.exports = {
  normalizePhone, waLink, render, siteUrl, applicationLink, loanBalance, buildContext, sendWhatsApp, dispatch,
  parseInbound, handleInbound, botReply, connectionStatus, connectionQR,
};
