'use strict';
// Armazenamento de documentos: Vercel Blob privado (produção) ou disco local (desenvolvimento/testes).
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const LIMITS = {
  image: { types: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'], max: 15 * 1024 * 1024 },
  video: { types: ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp', 'video/x-matroska'], max: 200 * 1024 * 1024 },
  file: { types: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'], max: 20 * 1024 * 1024 },
};

function createStorage({ dir } = {}) {
  const useBlob = !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
  if (useBlob) {
    const blob = require('@vercel/blob');
    return {
      mode: 'blob',
      async head(pathname) {
        try { return await blob.head(pathname); } catch { return null; }
      },
      async stream(pathname, res, req) {
        const r = await blob.get(pathname, { access: 'private', ifNoneMatch: req.headers['if-none-match'] });
        if (!r) return res.status(404).send('Arquivo não encontrado');
        if (r.statusCode === 304) { res.status(304).end(); return; }
        res.setHeader('Content-Type', r.blob.contentType || 'application/octet-stream');
        if (r.blob.etag) res.setHeader('ETag', r.blob.etag);
        res.setHeader('Cache-Control', 'private, no-cache');
        Readable.fromWeb(r.stream).pipe(res);
      },
      async remove(pathname) { try { await blob.del(pathname); } catch { /* ignore */ } },
      async readBuffer(pathname) {
        const r = await blob.get(pathname, { access: 'private' });
        if (!r || r.statusCode !== 200) throw new Error('Arquivo não encontrado');
        return Buffer.from(await new Response(r.stream).arrayBuffer());
      },
    };
  }
  const root = dir || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads');
  const safe = (p) => {
    const full = path.resolve(root, p);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Caminho inválido');
    return full;
  };
  return {
    mode: 'local',
    root,
    async put(pathname, buffer) {
      const full = safe(pathname);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buffer);
    },
    async head(pathname) {
      try { const st = fs.statSync(safe(pathname)); return { size: st.size, pathname }; } catch { return null; }
    },
    async stream(pathname, res, req, contentType) {
      const full = safe(pathname);
      if (!fs.existsSync(full)) return res.status(404).send('Arquivo não encontrado');
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, no-cache');
      void req;
      fs.createReadStream(full).pipe(res);
    },
    async remove(pathname) { try { fs.rmSync(safe(pathname), { force: true }); } catch { /* ignore */ } },
    async readBuffer(pathname) { return fs.readFileSync(safe(pathname)); },
  };
}

module.exports = { createStorage, LIMITS };
