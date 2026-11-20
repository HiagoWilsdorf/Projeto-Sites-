'use strict';
// Ponto de entrada.
// - Na Vercel: o app Express exportado roda como Function (o banco conecta na 1ª requisição).
// - Localmente (`npm run dev`): sobe o servidor com Postgres embutido (PGlite) e o agendador.
const path = require('node:path');
const express = require('express');
const { createApp } = require('./src/app');

if (require.main === module) {
  const { connect } = require('./src/db');
  const { runAutomations } = require('./src/scheduler');
  connect().then((db) => {
    const app = createApp({ db });
    app.use(express.static(path.join(__dirname, 'public'))); // na Vercel a pasta public/ é servida pela CDN
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => console.log(`Gestão de Empréstimos em http://localhost:${port}`));
    const tick = () => runAutomations(db).then((r) => r.created && console.log('[automação]', r)).catch((e) => console.error('[automação]', e));
    setInterval(tick, 15 * 60000).unref();
  }).catch((e) => { console.error(e); process.exit(1); });
} else {
  module.exports = createApp();
}
