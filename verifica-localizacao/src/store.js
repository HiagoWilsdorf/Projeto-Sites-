'use strict';
// Armazenamento simples em um único documento JSON.
// - Produção (Vercel): Vercel Blob (variável BLOB_READ_WRITE_TOKEN criada ao conectar o Blob).
// - Desenvolvimento: arquivo local em data/checks.json.
// - Testes: em memória.
// Observação: é um armazenamento simples (leitura-modificação-escrita), adequado para baixo
// volume/teste. Para produção com vários acessos simultâneos, migrar para um banco (Neon).
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Em vez de sobrescrever o mesmo arquivo (o Blob público cacheia a sobrescrita e serve versão
// antiga), cada escrita cria um arquivo novo e imutável; a leitura pega sempre o mais recente.
const PREFIX = 'verifica-localizacao/data-';
const EMPTY = { seq: 0, items: [] };

function createStore(opts = {}) {
  const token = opts.token || process.env.BLOB_READ_WRITE_TOKEN;
  let mode = opts.memory ? 'memory' : token ? 'blob' : 'local';
  if (opts.dir !== undefined) mode = 'local';

  // backend de leitura/escrita do documento inteiro
  let mem = { ...EMPTY };
  const localFile = () => path.join(opts.dir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'checks.json');

  async function readDoc() {
    if (mode === 'memory') return mem;
    if (mode === 'local') {
      try { return JSON.parse(fs.readFileSync(localFile(), 'utf8')); } catch { return { ...EMPTY }; }
    }
    const { list } = require('@vercel/blob');
    const { blobs } = await list({ prefix: PREFIX, token });
    if (!blobs.length) return { ...EMPTY };
    // o nome inclui timestamp; o maior pathname é a versão mais recente
    const latest = blobs.slice().sort((a, b) => a.pathname.localeCompare(b.pathname)).pop();
    const r = await fetch(latest.url, { cache: 'no-store' });
    if (!r.ok) return { ...EMPTY };
    try { return await r.json(); } catch { return { ...EMPTY }; }
  }

  async function writeDoc(doc) {
    if (mode === 'memory') { mem = doc; return; }
    if (mode === 'local') {
      const f = localFile();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(doc));
      return;
    }
    const { put, list, del } = require('@vercel/blob');
    const ts = Date.now().toString().padStart(16, '0');
    const name = `${PREFIX}${ts}-${crypto.randomBytes(4).toString('hex')}.json`;
    await put(name, JSON.stringify(doc), { access: 'public', addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 0, token });
    // remove versões antigas (mantém só a recém-escrita) para não acumular arquivos
    try {
      const { blobs } = await list({ prefix: PREFIX, token });
      const old = blobs.filter((b) => b.pathname !== name).map((b) => b.url);
      if (old.length) await del(old, { token });
    } catch { /* limpeza é best-effort */ }
  }

  // serializa as operações dentro desta instância para reduzir corrida de escrita
  let chain = Promise.resolve();
  const tx = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  return {
    mode,
    randomToken: (bytes = 16) => crypto.randomBytes(bytes).toString('hex'),

    create: (obj) => tx(async () => {
      const doc = await readDoc();
      const id = (doc.seq || 0) + 1;
      doc.seq = id;
      const row = { id, created_at: new Date().toISOString(), ...obj };
      doc.items = doc.items || [];
      doc.items.push(row);
      await writeDoc(doc);
      return row;
    }),

    getByToken: async (t) => (await readDoc()).items?.find((x) => x.token === String(t)) || null,
    getById: async (id) => (await readDoc()).items?.find((x) => x.id === Number(id)) || null,

    update: (id, patch) => tx(async () => {
      const doc = await readDoc();
      const row = (doc.items || []).find((x) => x.id === Number(id));
      if (!row) return null;
      Object.assign(row, patch);
      await writeDoc(doc);
      return row;
    }),

    updateByToken: (t, patch) => tx(async () => {
      const doc = await readDoc();
      const row = (doc.items || []).find((x) => x.token === String(t));
      if (!row) return null;
      Object.assign(row, patch);
      await writeDoc(doc);
      return row;
    }),

    list: async () => {
      const doc = await readDoc();
      return (doc.items || []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id).slice(0, 200);
    },

    remove: (id) => tx(async () => {
      const doc = await readDoc();
      doc.items = (doc.items || []).filter((x) => x.id !== Number(id));
      await writeDoc(doc);
      return true;
    }),
  };
}

module.exports = { createStore };
