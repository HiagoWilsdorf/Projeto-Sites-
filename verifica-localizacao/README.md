# Verifica Localização

Ferramenta independente para **confirmar a localização de uma pessoa por meio de um link**, sempre **com o consentimento dela**. Você gera um link no painel, envia (ex.: por WhatsApp), e quando a pessoa abre e autoriza, o sistema registra:

- **Localização aproximada pelo IP** (cidade/região/país) — automática.
- **Localização precisa por GPS** — o navegador da pessoa pede permissão; se ela permitir, você recebe o ponto exato + link do Google Maps.
- Data/hora e dispositivo do acesso.

Tudo fica no **painel protegido por senha**. Nada é capturado sem a pessoa tocar em "Autorizar" e, para o GPS, aceitar o pedido de permissão do navegador.

> ⚠️ Uso responsável e legal: a página sempre mostra um aviso e pede consentimento. Não remova esse aviso. Use apenas para finalidades legítimas (ex.: confirmação de cadastro/endereço) e informe a pessoa, conforme a LGPD.

## Como funciona o envio pelo WhatsApp
O painel monta um link "clique para conversar" (`wa.me`) com a mensagem e o link já prontos. Você toca em **Enviar pelo WhatsApp** e manda do seu próprio número — não precisa de API nem configuração extra.

## Rodar localmente
```bash
npm install
cp .env.example .env     # edite ADMIN_PASSWORD
npm run dev              # http://localhost:3000  (usa banco embutido PGlite)
npm test                 # testes
```

## Publicar na Vercel (produção)
1. Suba este projeto para um repositório no GitHub (veja abaixo).
2. Na Vercel: **Add New → Project** e selecione o repositório.
   - Se este código estiver numa subpasta, defina **Root Directory** como essa pasta.
   - **Framework Preset:** Express (ou "Other").
3. **Banco de dados:** no projeto da Vercel, aba **Storage → Create → Neon (Postgres)** e conecte. Isso cria a variável `DATABASE_URL` automaticamente. O sistema cria a tabela sozinho no primeiro acesso.
4. **Environment Variables** (Settings → Environment Variables):
   - `ADMIN_PASSWORD` — senha de acesso ao painel (obrigatória).
   - `SESSION_SECRET` — um texto longo e aleatório (recomendado).
   - `APP_NAME` — nome exibido (opcional, ex.: nome do cliente).
5. **Deploy.** Acesse a URL, entre com a senha e gere o primeiro link.

## Criar um repositório novo a partir desta pasta
```bash
# dentro desta pasta (verifica-localizacao/)
rm -rf .git
git init
git add .
git commit -m "Verifica Localização - versão inicial"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/NOME_DO_REPO.git
git push -u origin main
```

## Variáveis de ambiente
| Variável | Obrigatória | Para quê |
|---|---|---|
| `ADMIN_PASSWORD` | sim | Senha única do painel |
| `SESSION_SECRET` | recomendada | Assina o cookie de sessão |
| `APP_NAME` | não | Nome exibido no painel e na página pública |
| `DATABASE_URL` | prod | Postgres/Neon (na Vercel vem automático ao conectar o Neon) |
| `PUBLIC_URL` | não | Força a URL base nos links gerados |

## Observações importantes
- **Só clicar no link não basta:** a pessoa precisa autorizar e, para o GPS preciso, aceitar a permissão do navegador. Sem isso, você recebe só a cidade aproximada pelo IP.
- A geolocalização por IP usa serviços públicos gratuitos (ipwho.is / ipapi.co) e o endereço do GPS usa o OpenStreetMap (Nominatim); se algum falhar, o registro é salvo mesmo assim com o que estiver disponível.
