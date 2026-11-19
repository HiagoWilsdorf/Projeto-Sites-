# Gestão de Empréstimos

Aplicativo web de uso pessoal para controlar empréstimos de ponta a ponta: clientes (CRM), contratos, parcelas, recebimentos, juros de atraso, avisos de cobrança automáticos e mensagens pelo WhatsApp.

Funciona no computador e no celular (pode ser "instalado" na tela inicial como app).

## Como funciona o fluxo

1. **Análise e aprovação acontecem no seu WhatsApp** (documentos, conversa, decisão) — fora do app.
2. **Cliente aprovado → cadastro no app**: em *+ Novo cliente / empréstimo* você cadastra o cliente e o empréstimo na mesma tela.
3. **Confirmação**: o cliente recebe no WhatsApp a confirmação com todas as datas de cobrança.
4. **Cobranças automáticas** (regras padrão, editáveis em *Automações*):
   - **3 dias antes**: “a parcela X, no valor de R$ Y, será cobrada em DD/MM”;
   - **no dia do vencimento**;
   - **em atraso**: a partir do 1º dia, repetindo a cada 3 dias (até 5x), e aviso de atraso grave aos 15 dias (semanal);
5. **Pagamento**: ao registrar, o cliente recebe o recibo com o saldo restante.

O app envia **somente mensagens de cobrança**. Respostas dos clientes ficam registradas no histórico de cada cliente; números que não são clientes não são cadastrados.

## Funcionalidades

- **Painel**: valor a receber, capital na rua, valor em atraso e % de inadimplência, recebido no mês, lucro realizado e projetado, gráfico dos últimos 6 meses, atrasados e próximos vencimentos.
- **Clientes (CRM)**: cadastro com telefone, CPF, endereço, tags e score de confiança; histórico completo de interações (mensagens enviadas, respostas recebidas, anotações, pagamentos), botão direto para o WhatsApp.
- **Empréstimos**: simulação em tempo real antes de criar; três formas de cálculo:
  - *Juros simples* (parcelas iguais),
  - *Tabela Price* (juros compostos, parcelas fixas),
  - *Só juros* (paga juros a cada período e o principal na última);
  - parcelas mensais, quinzenais, semanais ou diárias; multa e juros de mora configuráveis por contrato.
- **Recebimentos**: pagamento total ou parcial, cálculo automático de multa + mora até a data do pagamento, opção de isentar encargos, valor excedente abatido nas próximas parcelas, estorno, renegociação de vencimento/valor, recibo automático por WhatsApp.
- **Cobranças**: agenda com atrasados, vencendo hoje e próximos dias, com botões "Cobrar" (mensagem pronta) e "Receber".
- **Automações**: regras configuráveis (X dias antes, no dia, X dias após o vencimento com repetição a cada N dias e limite de repetições), modelos de mensagem com variáveis (`{nome}`, `{valor}`, `{valor_atualizado}`, `{dias_atraso}`, `{pix}`, `{saldo_devedor}`…), janela de horário de envio e prevenção de mensagens duplicadas.
- **Mensagens**: central de envios (enviadas, pendentes de envio manual, falhas, respostas dos clientes).
- **Relatórios**: recebimentos por período e forma de pagamento, novos empréstimos, pontualidade; exportação CSV (Excel/Google Planilhas).
- **Segurança e dados**: acesso por senha, backup/restauração em JSON, banco SQLite local.

## WhatsApp — formas de envio

Configure em **Configurações → WhatsApp**:

| Modo | Como funciona |
|---|---|
| **Evolution API** / **Z-API** | Conexão direta do seu número: clique em *Conectar com QR Code* em Configurações e leia o código pelo WhatsApp (Aparelhos conectados). O app mostra o status da conexão e avisa no painel se cair. |
| **Meu CRM / automação** | Cada cobrança vai como `POST {"phone","message"}` para a URL do seu CRM, n8n, Make etc., que faz o envio. |
| **Manual** (padrão) | Sem custo e sem configuração. As cobranças automáticas ficam em "Mensagens → Envio manual" e o botão abre o WhatsApp (wa.me) com o texto pronto; basta tocar em enviar. |
| **WhatsApp Cloud API** (Meta, oficial) | Envio 100% automático. Informe token e Phone Number ID. Pela regra da Meta, mensagem livre só é entregue se o cliente falou com você nas últimas 24h; fora disso use modelos aprovados. |

**Respostas dos clientes no CRM**: copie a URL de webhook mostrada nas configurações e cadastre no seu provedor (Cloud API, Evolution ou Z-API). As mensagens recebidas aparecem no histórico do cliente e na aba "Mensagens".

## Como rodar

Requisitos: **Node.js 22.5+** (usa o SQLite embutido do Node, sem dependências nativas).

```bash
npm install
npm start          # http://localhost:3000
```

No primeiro acesso, o sistema pede para criar a senha.

Variáveis de ambiente opcionais: `PORT` (padrão 3000), `DATA_DIR` (pasta do banco, padrão `./data`).

Testes: `npm test`

### Hospedagem

Para as automações rodarem 24h, o app precisa ficar ligado num servidor (VPS, Railway, Render, Fly.io, um computador sempre ligado…). Ele **não** é compatível com hospedagens serverless (ex.: Vercel), porque usa banco em arquivo e um agendador interno.

Com Docker:

```bash
docker build -t emprestimos .
docker run -d -p 3000:3000 -v emprestimos-data:/data --name emprestimos emprestimos
```

Use HTTPS (proxy reverso como Caddy/Nginx ou o da própria plataforma) quando expor na internet, e faça backups periódicos em **Configurações → Backup**.

## Estrutura

```
server/
  index.js       inicialização + agendador
  app.js         API REST
  db.js          esquema SQLite, configurações e dados iniciais
  finance.js     cronograma de parcelas, multa e juros de mora
  messaging.js   modelos, variáveis e provedores de WhatsApp
  scheduler.js   regras de cobrança automática
  auth.js        senha e sessões
public/          interface (HTML/CSS/JS, sem build)
test/            testes (node:test)
```
