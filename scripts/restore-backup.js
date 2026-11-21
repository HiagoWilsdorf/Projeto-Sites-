#!/usr/bin/env node
'use strict';
/*
 * Restaura um backup no banco de dados.
 * ATENÇÃO: apaga todos os dados atuais do banco indicado e grava os do backup.
 *
 * Uso:
 *   DATABASE_URL=... BACKUP_ENCRYPTION_KEY=... node scripts/restore-backup.js <arquivo-local> --confirmar
 *   DATABASE_URL=... BACKUP_ENCRYPTION_KEY=... BACKUP_READ_WRITE_TOKEN=... node scripts/restore-backup.js --ultimo --confirmar
 *   node scripts/restore-backup.js --listar        (lista os backups disponíveis)
 *
 * Os documentos (fotos, vídeos, PDFs) ficam copiados em "files/" no armazenamento de backup,
 * com o mesmo caminho do armazenamento original.
 */
const fs = require('node:fs');
const { connect } = require('../src/db');
const backup = require('../src/backup');

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--listar')) {
    for (const b of await backup.listBackups()) console.log(b.pathname, `${Math.round(b.size / 1024)} KB`, b.uploaded_at);
    return;
  }
  const confirm = args.includes('--confirmar');
  const source = args.find((a) => !a.startsWith('--'));
  let buffer;
  let label;
  if (args.includes('--ultimo')) {
    const list = await backup.listBackups();
    if (!list.length) throw new Error('Nenhum backup encontrado');
    label = list[0].pathname;
    buffer = await backup.target().read(label);
  } else if (source) {
    label = source;
    buffer = fs.readFileSync(source);
  } else {
    console.log('Informe um arquivo, ou --ultimo, ou --listar.');
    process.exit(1);
  }
  const data = backup.open(buffer);
  const counts = Object.entries(data.tables).map(([t, rows]) => `${t}: ${rows.length}`).join(', ');
  console.log(`Backup ${label} de ${data.created_at}\n${counts}`);
  if (!confirm) {
    console.log('\nNada foi alterado. Rode de novo com --confirmar para substituir TODOS os dados do banco por este backup.');
    return;
  }
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) throw new Error('Defina DATABASE_URL do banco de destino');
  const db = await connect();
  await backup.restore(db, data);
  await db.close();
  console.log('Restauração concluída.');
})().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
