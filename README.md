# Gestão de Empréstimos

Site para gestão de empréstimos com **conta central** e **afiliados**, cadastro de clientes com envio de documentos pelo próprio cliente, análise e aprovação no site, cobranças automáticas e WhatsApp.

Hospedagem: **Vercel** (site + funções), **Postgres** (Neon, pela Vercel) e **Vercel Blob privado** (fotos, vídeos e documentos).

## Contas

- **Conta central (administrador):** vê 100% de tudo — painéis, clientes, empréstimos, dívidas, cadastros e documentos de todos os afiliados. No menu lateral, o seletor **Visualizando** alterna entre "Todas as contas" e uma conta específica. Cria, edita, desativa afiliados e redefine senhas. Edita regras de cobrança, modelos de mensagem, textos do bot e documentos exigidos.
- **Afiliado:** login e senha próprios; vê somente os próprios clientes, cadastros, empréstimos, cobranças e painel. Tem o próprio WhatsApp, PIX e link de cadastro.

O primeiro acesso ao site cria a conta central.

## Fluxo do cliente

1. A pessoa manda mensagem no WhatsApp da central ou de um afiliado.
2. O bot responde com um **link de cadastro pessoal** (também há um link geral por conta para divulgar).
3. Pelo link, o cliente preenche os dados e envia **fotos, vídeos e documentos** (tirando na hora ou da galeria).
4. No site, em **Cadastros**, a conta responsável vê cada arquivo, **aprova ou recusa** com motivo e:
   - **Pede correções** → o cliente recebe no WhatsApp a lista do que foi recusado e reenvia pelo mesmo link;
   - **Aprova** → o cliente é criado com todos os dados e documentos, e já pode receber o empréstimo;
   - **Recusa** → opcionalmente avisa o cliente.
5. Ao liberar o empréstimo, o cliente recebe a confirmação com **todas as datas de cobrança**.
6. **Cobranças automáticas** (todo dia pela manhã): 3 dias antes, no dia e em atraso (com repetição), pelo WhatsApp da conta dona do cliente.
7. Ao registrar pagamento, o cliente recebe o recibo. Clientes podem consultar parcela, saldo e PIX pelo menu do bot.

## WhatsApp por conta

Em **Configurações → WhatsApp desta conta**: Z-API ou Evolution API (conexão por QR Code), Cloud API oficial, envio para um CRM próprio (URL) ou modo manual. Cada conta copia a **URL de webhook** mostrada ali para o painel do provedor — é por ela que o site recebe as mensagens (novos contatos e menu do bot).

## Publicação na Vercel

1. Projeto Vercel ligado a este repositório (o Express é detectado automaticamente; `public/` é servido pela CDN).
2. **Banco**: Storage → Create Database → **Neon (Postgres)** e conectar ao projeto (cria `DATABASE_URL`). As tabelas são criadas sozinhas no primeiro acesso.
3. **Arquivos**: Storage → **Blob** com acesso **privado**, conectado ao projeto (cria `BLOB_READ_WRITE_TOKEN`).
4. Variável `CRON_SECRET` (qualquer texto aleatório) — protege o disparo diário das cobranças (`vercel.json`, 08:30 de Brasília).
5. Opcional: `PUBLIC_URL` com o domínio final (usado nos links enviados pelo bot).

> No plano Hobby da Vercel o agendador roda 1 vez por dia e o uso comercial não é permitido pelos termos da Vercel; para operação comercial use o plano Pro.

## Desenvolvimento local

```bash
npm install
npm run dev     # http://localhost:3000 — usa Postgres embutido (PGlite) em ./data, sem instalar nada
npm test        # testes automatizados
```

Sem `DATABASE_URL`, o banco embutido é usado; sem `BLOB_READ_WRITE_TOKEN`, os arquivos ficam em `./data/uploads`.

## Estrutura

```
server.js          entrada (Vercel / local)
src/app.js         API (contas, clientes, empréstimos, cadastros, cobranças, webhooks, cron)
src/db.js          Postgres / PGlite, tabelas e dados iniciais
src/auth.js        login por e-mail e senha, sessões
src/messaging.js   modelos, WhatsApp (Z-API, Evolution, Cloud API, URL), bot
src/scheduler.js   regras de cobrança automática
src/storage.js     Vercel Blob privado / disco local
src/finance.js     parcelas, juros, multa e mora
public/            painel (app.js) e página de cadastro do cliente (cadastro.html)
vendor/            fonte do bundle de upload do Vercel Blob (npm run build:vendor)
```
