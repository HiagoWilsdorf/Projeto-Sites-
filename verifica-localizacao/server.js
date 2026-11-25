'use strict';
// Entrada. Local: sobe o servidor com banco embutido (PGlite) se não houver DATABASE_URL.
// Vercel: exporta o app Express como Function (o banco conecta na 1ª requisição).
const { createApp } = require('./src/app');

if (require.main === module) {
  const { connect } = require('./src/db');
  connect().then((db) => {
    const app = createApp({ db });
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => console.log(`${process.env.APP_NAME || 'Verifica Localização'} em http://localhost:${port}`));
  }).catch((e) => { console.error(e); process.exit(1); });
} else {
  module.exports = createApp();
}
