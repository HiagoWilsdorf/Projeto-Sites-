'use strict';
const db = require('./db').open();
const { createApp } = require('./app');
const { startScheduler } = require('./scheduler');

const scheduler = startScheduler(db);
const app = createApp(db, { scheduler });
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Gestão de Empréstimos rodando em http://localhost:${PORT}`);
});
