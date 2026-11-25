'use strict';
// Banco: Postgres (produção / Neon na Vercel) ou PGlite (desenvolvimento, embutido).
const path = require('node:path');
const crypto = require('node:crypto');

async function connect({ url = process.env.DATABASE_URL || process.env.POSTGRES_URL, dir } = {}) {
  let db;
  if (url) {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => parseInt(v, 10));
    pg.types.setTypeParser(1700, (v) => parseFloat(v));
    const pool = new pg.Pool({
      connectionString: url,
      max: 5,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    });
    db = {
      kind: 'postgres',
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
      exec: (sql) => pool.query(sql),
      close: () => pool.end(),
    };
  } else {
    if (process.env.VERCEL) {
      throw Object.assign(new Error('Banco de dados não configurado: conecte o Neon Postgres ao projeto na Vercel.'), { status: 503 });
    }
    const { PGlite } = require('@electric-sql/pglite');
    const target = dir === undefined ? path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'pglite') : dir;
    if (target) require('node:fs').mkdirSync(target, { recursive: true });
    const lite = new PGlite(target || undefined, { parsers: { 20: (v) => parseInt(v, 10), 1700: (v) => parseFloat(v) } });
    let chain = Promise.resolve();
    const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
    db = {
      kind: 'pglite',
      query: (sql, params = []) => serial(async () => (await lite.query(sql, params)).rows),
      exec: (sql) => serial(() => lite.exec(sql)),
      close: () => lite.close(),
    };
  }
  db.one = async (sql, params) => (await db.query(sql, params))[0] || null;
  await migrate(db);
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checks (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  label TEXT,                                 -- identificação do destinatário (nome/telefone), opcional
  phone TEXT,                                 -- telefone para montar o link de WhatsApp, opcional
  purpose TEXT,                               -- texto mostrado ao destinatário, opcional
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | captured | denied | expired
  ip TEXT,
  ip_city TEXT, ip_region TEXT, ip_country TEXT,
  ip_lat DOUBLE PRECISION, ip_lng DOUBLE PRECISION, ip_org TEXT,
  gps_lat DOUBLE PRECISION, gps_lng DOUBLE PRECISION, gps_accuracy DOUBLE PRECISION,
  gps_address TEXT,
  consent BOOLEAN NOT NULL DEFAULT FALSE,
  consent_text TEXT,
  user_agent TEXT,
  captured_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checks_created ON checks(created_at);
`;

async function migrate(db) {
  await db.exec(SCHEMA);
}

const randomToken = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

module.exports = { connect, migrate, randomToken };
