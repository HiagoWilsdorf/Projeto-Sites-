'use strict';
// Backup diário criptografado do banco de dados e dos documentos, guardado em um armazenamento separado
// (Vercel Blob privado em outra região). Sem token configurado (desenvolvimento/testes), grava em ./data/backups.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { getSettings, setSettings } = require('./db');

// Ordem respeita as dependências entre tabelas (usada também na restauração).
const TABLES = ['users', 'settings', 'templates', 'rules', 'document_types', 'clients', 'applications', 'loans',
  'installments', 'payments', 'application_files', 'messages'];
const MAGIC = Buffer.from('EMPBKP1');
const RETENTION_DAYS = 90;

function encryptionKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY inválida (precisa ter 32 bytes em base64)');
  return key;
}

/** Comprime e criptografa (AES-256-GCM). Sem chave, apenas comprime. */
function seal(obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  const key = encryptionKey();
  if (!key) return { buffer: gz, encrypted: false };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(gz), cipher.final()]);
  return { buffer: Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]), encrypted: true };
}

function open(buffer) {
  let gz = buffer;
  if (buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    const key = encryptionKey();
    if (!key) throw new Error('Backup criptografado: defina BACKUP_ENCRYPTION_KEY para abrir');
    const iv = buffer.subarray(MAGIC.length, MAGIC.length + 12);
    const tag = buffer.subarray(MAGIC.length + 12, MAGIC.length + 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    gz = Buffer.concat([decipher.update(buffer.subarray(MAGIC.length + 28)), decipher.final()]);
  }
  return JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
}

/** Destino dos backups: Blob privado separado (BACKUP_READ_WRITE_TOKEN) ou pasta local. */
function target({ dir } = {}) {
  const token = process.env.BACKUP_READ_WRITE_TOKEN;
  if (token) {
    const blob = require('@vercel/blob');
    return {
      mode: 'blob',
      async put(pathname, body, { ttl } = {}) {
        await blob.put(pathname, body, { access: 'private', token, allowOverwrite: true, addRandomSuffix: false, ...(ttl ? { ttlDays: ttl } : {}) });
      },
      async list(prefix) {
        const out = [];
        let cursor;
        do {
          const r = await blob.list({ prefix, token, cursor, limit: 1000 });
          out.push(...r.blobs.map((b) => ({ pathname: b.pathname, size: b.size, uploaded_at: b.uploadedAt })));
          cursor = r.hasMore ? r.cursor : undefined;
        } while (cursor);
        return out;
      },
      async read(pathname) {
        const r = await blob.get(pathname, { access: 'private', token });
        if (!r || r.statusCode !== 200) throw new Error('Backup não encontrado');
        return Buffer.from(await new Response(r.stream).arrayBuffer());
      },
    };
  }
  const root = dir || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'backups');
  const full = (p) => {
    const f = path.resolve(root, p);
    if (!f.startsWith(path.resolve(root) + path.sep)) throw new Error('Caminho inválido');
    return f;
  };
  return {
    mode: 'local',
    async put(pathname, body) {
      const f = full(pathname);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (Buffer.isBuffer(body)) fs.writeFileSync(f, body);
      else await new Promise((res, rej) => Readable.from(body).pipe(fs.createWriteStream(f)).on('finish', res).on('error', rej));
    },
    async list(prefix) {
      const d = full(prefix || '.');
      const walk = (dirPath) => (fs.existsSync(dirPath) ? fs.readdirSync(dirPath, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dirPath, e.name);
        if (e.isDirectory()) return walk(p);
        const st = fs.statSync(p);
        return [{ pathname: path.relative(root, p).split(path.sep).join('/'), size: st.size, uploaded_at: st.mtime }];
      }) : []);
      return walk(d);
    },
    async read(pathname) { return fs.readFileSync(full(pathname)); },
  };
}

async function dump(db) {
  const tables = {};
  for (const t of TABLES) tables[t] = await db.query(`SELECT * FROM ${t} ORDER BY 1`);
  return { app: 'gestao-emprestimos', version: 1, created_at: new Date().toISOString(), tables };
}

/**
 * Faz o backup completo do banco + cópia dos documentos novos.
 * @param {object} opts { storage: armazenamento dos documentos (para copiar arquivos), dir: pasta local (testes) }
 */
async function runBackup(db, opts = {}) {
  const started = Date.now();
  const dest = target(opts);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    const data = await dump(db);
    const { buffer, encrypted } = seal(data);
    const pathname = `db/${stamp.slice(0, 10)}/backup-${stamp}.json.gz${encrypted ? '.enc' : ''}`;
    await dest.put(pathname, buffer, { ttl: RETENTION_DAYS });

    // Documentos: copia os arquivos ainda não copiados (incremental).
    const already = new Set((await dest.list('files/')).map((f) => f.pathname));
    let copied = 0;
    let failedFiles = 0;
    if (opts.storage) {
      for (const f of data.tables.application_files) {
        const to = `files/${f.pathname}`;
        if (already.has(to)) continue;
        try {
          await dest.put(to, await opts.storage.readBuffer(f.pathname));
          copied++;
        } catch (e) {
          failedFiles++;
          console.error('[backup] arquivo', f.pathname, e.message);
        }
      }
    }
    const counts = Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, v.length]));
    const result = { ok: failedFiles === 0, at: new Date().toISOString(), pathname, size: buffer.length, encrypted, files_copied: copied, files_failed: failedFiles, counts, seconds: Math.round((Date.now() - started) / 1000), mode: dest.mode };
    await setSettings(db, { backup_last: JSON.stringify(result) });
    return result;
  } catch (e) {
    const result = { ok: false, at: new Date().toISOString(), error: e.message, mode: dest.mode };
    try { await setSettings(db, { backup_last: JSON.stringify(result) }); } catch { /* banco fora do ar */ }
    console.error('[backup] falhou', e);
    return result;
  }
}

async function listBackups(opts = {}) {
  const dest = target(opts);
  const list = await dest.list('db/');
  return list.sort((a, b) => String(b.pathname).localeCompare(String(a.pathname)));
}

async function lastStatus(db) {
  try { return JSON.parse((await getSettings(db)).backup_last || 'null'); } catch { return null; }
}

/** Restaura um backup (apaga TODOS os dados atuais e grava os do backup). */
async function restore(db, data) {
  if (!data || data.app !== 'gestao-emprestimos' || !data.tables) throw new Error('Arquivo de backup inválido');
  await db.tx(async (q) => {
    await q.query(`TRUNCATE ${[...TABLES, 'sessions'].join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of TABLES) {
      for (const row of data.tables[t] || []) {
        const cols = Object.keys(row);
        const vals = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' && !(row[c] instanceof Date) && !/_at$/.test(c) ? JSON.stringify(row[c]) : row[c]));
        await q.query(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
      }
      if (t !== 'settings') await q.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${t}), 0), 1), (SELECT COUNT(*) > 0 FROM ${t}))`);
    }
  });
}

module.exports = { runBackup, listBackups, lastStatus, restore, seal, open, target, TABLES };
