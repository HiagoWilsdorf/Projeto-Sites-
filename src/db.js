'use strict';
// Camada de banco de dados: Postgres (produção / Vercel) ou PGlite (desenvolvimento e testes).
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Cria a conexão.
 * - DATABASE_URL / POSTGRES_URL definido → Postgres (Neon na Vercel).
 * - caso contrário → PGlite (Postgres embutido) em ./data/pglite ou em memória (testes).
 */
async function connect({ url = process.env.DATABASE_URL || process.env.POSTGRES_URL, dir } = {}) {
  let db;
  if (url) {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // int8
    pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric
    const pool = new pg.Pool({
      connectionString: url,
      max: 5,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    });
    db = {
      kind: 'postgres',
      async query(sql, params = []) { return (await pool.query(sql, params)).rows; },
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const r = await fn({ query: async (s, p = []) => (await client.query(s, p)).rows, exec: (s) => client.query(s) });
          await client.query('COMMIT');
          return r;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    if (process.env.VERCEL) {
      throw Object.assign(new Error('Banco de dados não configurado: conecte o Postgres (Neon) ao projeto na Vercel.'), { status: 503 });
    }
    const { PGlite } = require('@electric-sql/pglite');
    const target = dir === undefined ? path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'pglite') : dir;
    if (target) require('node:fs').mkdirSync(target, { recursive: true });
    const lite = new PGlite(target || undefined, { parsers: { 20: (v) => parseInt(v, 10), 1700: (v) => parseFloat(v) } });
    // PGlite processa uma consulta por vez; a fila evita misturar transações.
    let chain = Promise.resolve();
    const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
    db = {
      kind: 'pglite',
      query: (sql, params = []) => serial(async () => (await lite.query(sql, params)).rows),
      tx: (fn) => serial(() => lite.transaction((t) => fn({ query: async (s, p = []) => (await t.query(s, p)).rows, exec: (s) => t.exec(s) }))),
      close: () => lite.close(),
    };
  }
  db.one = async (sql, params) => (await db.query(sql, params))[0] || null;
  db.val = async (sql, params) => { const r = await db.one(sql, params); return r ? Object.values(r)[0] : null; };
  await migrate(db);
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'affiliate',          -- admin (conta central) | affiliate
  active BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,       -- PIX, nome exibido, WhatsApp da conta
  inbound_token TEXT NOT NULL UNIQUE,              -- webhook de entrada do WhatsApp da conta
  signup_slug TEXT NOT NULL UNIQUE,                -- link geral de cadastro da conta
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  phone TEXT,
  document TEXT,
  birth_date TEXT,
  email TEXT,
  address TEXT,
  occupation TEXT,
  income_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  tags TEXT,
  score INTEGER NOT NULL DEFAULT 3,
  whatsapp_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  application_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clients_owner ON clients(owner_id);

CREATE TABLE IF NOT EXISTS loans (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  principal_cents INTEGER NOT NULL,
  interest_rate DOUBLE PRECISION NOT NULL,
  method TEXT NOT NULL,
  frequency TEXT NOT NULL,
  installments_count INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  first_due_date TEXT NOT NULL,
  late_fee_percent DOUBLE PRECISION NOT NULL DEFAULT 2,
  late_interest_daily DOUBLE PRECISION NOT NULL DEFAULT 0.033,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loans_owner ON loans(owner_id, status);

CREATE TABLE IF NOT EXISTS installments (
  id SERIAL PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  principal_cents INTEGER NOT NULL DEFAULT 0,
  interest_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  penalty_cents INTEGER NOT NULL DEFAULT 0,
  waived_penalty BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'open',
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inst_due ON installments(status, due_date);
CREATE INDEX IF NOT EXISTS idx_inst_loan ON installments(loan_id);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  installment_id INTEGER NOT NULL REFERENCES installments(id) ON DELETE CASCADE,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  method TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pay_loan ON payments(loan_id);

CREATE TABLE IF NOT EXISTS templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0,
  repeat_every INTEGER NOT NULL DEFAULT 0,
  max_repeats INTEGER NOT NULL DEFAULT 0,
  template_id INTEGER NOT NULL REFERENCES templates(id),
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS applications (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | submitted | needs_changes | approved | rejected
  source TEXT,
  phone TEXT,
  name TEXT,
  document TEXT,
  birth_date TEXT,
  email TEXT,
  address TEXT,
  occupation TEXT,
  income_cents INTEGER NOT NULL DEFAULT 0,
  requested_cents INTEGER NOT NULL DEFAULT 0,
  requested_installments INTEGER NOT NULL DEFAULT 0,
  client_notes TEXT,
  review_notes TEXT,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_owner ON applications(owner_id, status);

CREATE TABLE IF NOT EXISTS document_types (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',   -- image | video | file
  instructions TEXT,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  sort INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS application_files (
  id SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  document_type_id INTEGER REFERENCES document_types(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  pathname TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reject_reason TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_app ON application_files(application_id);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  loan_id INTEGER REFERENCES loans(id) ON DELETE SET NULL,
  installment_id INTEGER REFERENCES installments(id) ON DELETE SET NULL,
  rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  dedupe_key TEXT UNIQUE,
  direction TEXT NOT NULL DEFAULT 'out',
  channel TEXT NOT NULL,
  kind TEXT,
  phone TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  provider_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_msg_owner ON messages(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_client ON messages(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_status ON messages(status);
`;

const DEFAULT_TEMPLATES = [
  ['Lembrete de vencimento',
    'Olá {primeiro_nome}! Lembrete: a parcela {parcela} do seu empréstimo, no valor de {valor}, será cobrada em {vencimento} (daqui a {dias_para_vencer} dia(s)).\n\nChave PIX: {pix}\n\n{empresa}'],
  ['Vence hoje',
    'Olá {primeiro_nome}, bom dia! A parcela {parcela} no valor de {valor} vence HOJE ({vencimento}).\n\nPIX: {pix}\nApós o pagamento, envie o comprovante por aqui. Obrigado!\n\n{empresa}'],
  ['Aviso de atraso',
    'Olá {primeiro_nome}. A parcela {parcela}, vencida em {vencimento}, está em aberto há {dias_atraso} dia(s).\n\nValor original: {valor}\nValor atualizado (multa + juros): {valor_atualizado}\n\nPIX: {pix}\nPor favor, regularize o quanto antes ou entre em contato para combinarmos.\n\n{empresa}'],
  ['Atraso grave',
    '{primeiro_nome}, sua parcela {parcela} está em atraso há {dias_atraso} dias. Valor atualizado: {valor_atualizado}. Saldo devedor total: {saldo_devedor}.\n\nPrecisamos resolver essa pendência. Responda esta mensagem para negociarmos.\n\n{empresa}'],
  ['Confirmação do empréstimo',
    'Olá {primeiro_nome}! Seu empréstimo de {valor_emprestado} foi liberado. ✅\n\nTotal a pagar: {total_emprestimo} em {qtd_parcelas} parcela(s).\nDatas de cobrança:\n{cronograma}\n\nVocê receberá lembretes antes de cada vencimento.\nChave PIX para pagamento: {pix}\n\n{empresa}'],
  ['Recibo de pagamento',
    'Olá {primeiro_nome}! Confirmamos o recebimento de {valor_pago} referente à parcela {parcela}. Saldo devedor restante: {saldo_devedor}. Obrigado!\n\n{empresa}'],
];

const DEFAULT_RULES = [
  ['Lembrete 3 dias antes', 'before_due', 3, 0, 0, 0],
  ['Aviso no dia do vencimento', 'on_due', 0, 0, 0, 1],
  ['Atraso: 1 dia após (repete a cada 3 dias)', 'after_due', 1, 3, 5, 2],
  ['Atraso grave: 15 dias', 'after_due', 15, 7, 0, 3],
];

const DEFAULT_DOC_TYPES = [
  ['RG ou CNH — frente', 'image', 'Foto nítida da frente do documento, sem reflexo.', true],
  ['RG ou CNH — verso', 'image', 'Foto nítida do verso do documento.', true],
  ['Selfie segurando o documento', 'image', 'Seu rosto e o documento devem aparecer bem.', true],
  ['Comprovante de residência', 'file', 'Conta de luz, água ou internet dos últimos 3 meses (foto ou PDF).', true],
  ['Comprovante de renda', 'file', 'Holerite, extrato ou declaração (foto ou PDF).', true],
  ['Vídeo de confirmação', 'video', 'Grave um vídeo curto falando seu nome completo, CPF e o valor que está solicitando.', true],
];

// Configurações globais (definidas pela conta central).
const DEFAULT_SETTINGS = {
  system_name: 'Gestão de Empréstimos',
  timezone: 'America/Sao_Paulo',
  default_country_code: '55',
  default_late_fee_percent: '2',
  default_late_interest_daily: '0.033',
  send_receipt_on_payment: '1',
  send_release_message: '1',
  automations_enabled: '1',
  send_window_start: '08:00',
  send_window_end: '20:00',
  bot_enabled: '1',
  bot_new_contact: '1',
  bot_welcome: 'Olá! Obrigado pelo contato com {empresa}. 😊\n\nPara solicitar seu empréstimo, faça seu cadastro e envie os documentos por este link:\n{link}\n\nAssim que recebermos, faremos a análise e retornamos por aqui.',
  bot_pending: 'Olá {primeiro_nome}! Seu cadastro ainda não foi finalizado. Continue por aqui: {link}',
  bot_in_review: 'Olá {primeiro_nome}! Recebemos seu cadastro e ele está em análise. Avisaremos por aqui assim que terminar. 🙏',
  bot_menu: 'Olá {primeiro_nome}! Digite:\n*1* – Próxima parcela\n*2* – Saldo devedor\n*3* – Chave PIX\n*4* – Falar com atendente',
  bot_human_reply: 'Certo! Já avisei o atendente, em breve você será respondido.',
  msg_needs_changes: 'Olá {primeiro_nome}! Analisamos seu cadastro e precisamos que você reenvie alguns itens:\n{pendencias}\n\nUse o mesmo link: {link}\n\n{empresa}',
  msg_approved: 'Olá {primeiro_nome}! 🎉 Seu cadastro foi aprovado. Em breve entraremos em contato para a liberação do valor.\n\n{empresa}',
  msg_rejected: 'Olá {primeiro_nome}. Após análise, infelizmente não poderemos seguir com seu pedido neste momento.\n\n{empresa}',
};

// Configurações de cada conta (central e afiliados).
const DEFAULT_ACCOUNT_SETTINGS = {
  business_name: '',
  pix_key: '',
  wa_provider: 'manual',
  wa_cloud_token: '', wa_cloud_phone_id: '', wa_cloud_api_version: 'v21.0',
  wa_evolution_url: '', wa_evolution_instance: '', wa_evolution_apikey: '',
  wa_zapi_instance: '', wa_zapi_token: '', wa_zapi_client_token: '',
  wa_webhook_url: '',
};

async function migrate(db) {
  await db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(424242)');
    await q.exec(SCHEMA);
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      await q.query('INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, v]);
    }
    const [{ c }] = await q.query('SELECT COUNT(*)::int c FROM templates');
    if (c === 0) {
      const ids = [];
      for (const [n, b] of DEFAULT_TEMPLATES) ids.push((await q.query('INSERT INTO templates(name, body) VALUES ($1,$2) RETURNING id', [n, b]))[0].id);
      for (const [n, t, d, r, m, ti] of DEFAULT_RULES) {
        await q.query('INSERT INTO rules(name, trigger, days, repeat_every, max_repeats, template_id, channel) VALUES ($1,$2,$3,$4,$5,$6,$7)', [n, t, d, r, m, ids[ti], 'whatsapp']);
      }
    }
    const [{ d }] = await q.query('SELECT COUNT(*)::int d FROM document_types');
    if (d === 0) {
      let i = 0;
      for (const [n, k, ins, req] of DEFAULT_DOC_TYPES) await q.query('INSERT INTO document_types(name, kind, instructions, required, sort) VALUES ($1,$2,$3,$4,$5)', [n, k, ins, req, i++]);
    }
  });
}

async function getSettings(db) {
  const rows = await db.query('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function setSettings(db, obj) {
  for (const [k, v] of Object.entries(obj)) {
    await db.query('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v == null ? '' : String(v)]);
  }
}

/** Configurações efetivas de uma conta (globais + da conta). */
async function accountSettings(db, ownerId) {
  const g = await getSettings(db);
  const u = await db.one('SELECT id, name, settings FROM users WHERE id=$1', [ownerId]);
  const own = { ...DEFAULT_ACCOUNT_SETTINGS, ...(u?.settings || {}) };
  return { ...g, ...own, business_name: own.business_name || u?.name || g.system_name, owner_id: ownerId };
}

const randomToken = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

module.exports = { connect, getSettings, setSettings, accountSettings, randomToken, DEFAULT_SETTINGS, DEFAULT_ACCOUNT_SETTINGS };
