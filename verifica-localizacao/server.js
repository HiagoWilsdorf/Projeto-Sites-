'use strict';
// Entrada. Local: armazenamento em arquivo (data/checks.json). Vercel: Blob (via token).
const { createApp } = require('./src/app');

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`${process.env.APP_NAME || 'Verifica Localização'} em http://localhost:${port}`));
} else {
  module.exports = createApp();
}
