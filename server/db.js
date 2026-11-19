'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function open(file) {
  const target = file || process.env.DB_FILE || path.join(DATA_DIR, 'emprestimos.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  document TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  tags TEXT,
  score INTEGER NOT NULL DEFAULT 3,
  whatsapp_opt_in INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  principal_cents INTEGER NOT NULL,
  interest_rate REAL NOT NULL,          -- % por período
  method TEXT NOT NULL,                 -- simple | price | interest_only
  frequency TEXT NOT NULL,              -- monthly | biweekly | weekly | daily
  installments_count INTEGER NOT NULL,
  start_date TEXT NOT NULL,             -- data do empréstimo
  first_due_date TEXT NOT NULL,
  late_fee_percent REAL NOT NULL DEFAULT 2,     -- multa (%) única
  late_interest_daily REAL NOT NULL DEFAULT 0.033, -- juros de mora (% ao dia)
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | paid | canceled
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS installments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  principal_cents INTEGER NOT NULL DEFAULT 0,
  interest_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  penalty_cents INTEGER NOT NULL DEFAULT 0,   -- encargos congelados na quitação
  waived_penalty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',        -- open | paid | canceled
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inst_due ON installments(status, due_date);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installment_id INTEGER NOT NULL REFERENCES installments(id) ON DELETE CASCADE,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,          -- before_due | on_due | after_due
  days INTEGER NOT NULL DEFAULT 0,
  repeat_every INTEGER NOT NULL DEFAULT 0, -- só para after_due: repetir a cada N dias (0 = não repete)
  max_repeats INTEGER NOT NULL DEFAULT 0,  -- 0 = ilimitado
  template_id INTEGER NOT NULL REFERENCES templates(id),
  channel TEXT NOT NULL DEFAULT 'whatsapp', -- whatsapp | crm
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id),
  loan_id INTEGER REFERENCES loans(id) ON DELETE SET NULL,
  installment_id INTEGER REFERENCES installments(id) ON DELETE SET NULL,
  rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  dedupe_key TEXT UNIQUE,
  direction TEXT NOT NULL DEFAULT 'out',  -- out | in | note
  channel TEXT NOT NULL,                  -- whatsapp | crm
  kind TEXT,                              -- reminder | due | overdue | manual | note | inbound | receipt
  body TEXT NOT NULL,
  status TEXT NOT NULL,                   -- sent | pending_manual | failed | logged | received
  error TEXT,
  provider_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_client ON messages(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_status ON messages(status);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Colunas adicionadas depois da primeira versão (migração automática).
const EXTRA_COLUMNS = {
  clients: {
    stage: "TEXT NOT NULL DEFAULT 'client'", // lead | analysis | approved | rejected | client
    requested_cents: 'INTEGER NOT NULL DEFAULT 0',
    doc_checklist: "TEXT NOT NULL DEFAULT '{}'",
    source: 'TEXT',
    stage_updated_at: 'TEXT',
  },
};

const DEFAULT_TEMPLATES = [
  ['Lembrete de vencimento',
    'Olá {primeiro_nome}! Lembrete: a parcela {parcela} do seu empréstimo, no valor de {valor}, será cobrada em {vencimento} (daqui a {dias_para_vencer} dia(s)).\n\nChave PIX: {pix}\n\n{empresa}'],
  ['Vence hoje',
    'Olá {primeiro_nome}, bom dia! A parcela {parcela} no valor de {valor} vence HOJE ({vencimento}).\n\nPIX: {pix}\nApós o pagamento, envie o comprovante por aqui. Obrigado!\n\n{empresa}'],
  ['Aviso de atraso',
    'Olá {primeiro_nome}. Identificamos que a parcela {parcela}, vencida em {vencimento}, está em aberto há {dias_atraso} dia(s).\n\nValor original: {valor}\nValor atualizado (multa + juros): {valor_atualizado}\n\nPIX: {pix}\nPor favor, regularize o quanto antes ou entre em contato para combinarmos.\n\n{empresa}'],
  ['Atraso grave',
    '{primeiro_nome}, sua parcela {parcela} está em atraso há {dias_atraso} dias. Valor atualizado: {valor_atualizado}. Saldo devedor total: {saldo_devedor}.\n\nPrecisamos resolver essa pendência. Responda esta mensagem para negociarmos.\n\n{empresa}'],
  ['Empréstimo liberado',
    'Olá {primeiro_nome}! Seu empréstimo de {valor_emprestado} foi liberado. ✅\n\nTotal a pagar: {total_emprestimo} em {qtd_parcelas} parcela(s).\nDatas de cobrança:\n{cronograma}\n\nVocê receberá lembretes antes de cada vencimento.\nChave PIX para pagamento: {pix}\n\n{empresa}'],
  ['Recibo de pagamento',
    'Olá {primeiro_nome}! Confirmamos o recebimento de {valor_pago} referente à parcela {parcela}. Saldo devedor restante: {saldo_devedor}. Obrigado!\n\n{empresa}'],
];

const DEFAULT_RULES = [
  // name, trigger, days, repeat_every, max_repeats, templateIndex
  ['Lembrete 3 dias antes', 'before_due', 3, 0, 0, 0],
  ['Aviso no dia do vencimento', 'on_due', 0, 0, 0, 1],
  ['Atraso: 1 dia após (repete a cada 3 dias)', 'after_due', 1, 3, 5, 2],
  ['Atraso grave: 15 dias', 'after_due', 15, 7, 0, 3],
];

const DEFAULT_SETTINGS = {
  business_name: 'Minha Gestão de Empréstimos',
  pix_key: '',
  timezone: 'America/Sao_Paulo',
  send_window_start: '08:00',
  send_window_end: '20:00',
  scheduler_enabled: '1',
  scheduler_interval_minutes: '15',
  send_receipt_on_payment: '1',
  default_late_fee_percent: '2',
  default_late_interest_daily: '0.033',
  wa_provider: 'manual', // manual | cloud | evolution | zapi | webhook
  wa_cloud_token: '',
  wa_cloud_phone_id: '',
  wa_cloud_api_version: 'v21.0',
  wa_evolution_url: '',
  wa_evolution_instance: '',
  wa_evolution_apikey: '',
  wa_zapi_instance: '',
  wa_zapi_token: '',
  wa_zapi_client_token: '',
  wa_webhook_url: '',
  wa_inbound_token: '',
  default_country_code: '55',
  required_documents: 'RG ou CNH (frente e verso)\nCPF\nComprovante de residência\nComprovante de renda\nSelfie segurando o documento',
  send_release_message: '1',
  bot_enabled: '0',
  bot_new_contact_enabled: '1',
  bot_welcome: 'Olá! Obrigado pelo contato com {empresa}. 😊\n\nPara analisarmos seu pedido de empréstimo, envie por aqui:\n{documentos}\n\nInforme também o valor desejado. Assim que recebermos, faremos a análise.',
  bot_menu: 'Olá {primeiro_nome}! Digite:\n*1* – Próxima parcela\n*2* – Saldo devedor\n*3* – Chave PIX\n*4* – Falar com atendente',
  bot_human_reply: 'Certo! Já avisei o atendente, em breve você será respondido.',
};

function migrate(db) {
  db.exec(SCHEMA);
  for (const [table, cols] of Object.entries(EXTRA_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, def] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  const count = db.prepare('SELECT COUNT(*) c FROM templates').get().c;
  if (count === 0) {
    const insT = db.prepare('INSERT INTO templates(name, body) VALUES (?, ?)');
    const ids = DEFAULT_TEMPLATES.map(([n, b]) => Number(insT.run(n, b).lastInsertRowid));
    const insR = db.prepare('INSERT INTO rules(name, trigger, days, repeat_every, max_repeats, template_id, channel) VALUES (?,?,?,?,?,?,?)');
    for (const [n, t, d, r, m, ti] of DEFAULT_RULES) insR.run(n, t, d, r, m, ids[ti], 'whatsapp');
  }
  // Garante modelos novos em bancos antigos.
  for (const [n, b] of DEFAULT_TEMPLATES) {
    if (!db.prepare('SELECT 1 FROM templates WHERE name=?').get(n)) db.prepare('INSERT INTO templates(name, body) VALUES (?, ?)').run(n, b);
  }
  // Token aleatório para o webhook de entrada, se ainda não existir.
  const tok = db.prepare("SELECT value FROM settings WHERE key='wa_inbound_token'").get();
  if (!tok || !tok.value) {
    db.prepare("UPDATE settings SET value=? WHERE key='wa_inbound_token'")
      .run(require('node:crypto').randomBytes(16).toString('hex'));
  }
}

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSettings(db, obj) {
  const st = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(obj)) st.run(k, v == null ? '' : String(v));
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { DATA_DIR, open, getSettings, setSettings, tx, DEFAULT_SETTINGS };
