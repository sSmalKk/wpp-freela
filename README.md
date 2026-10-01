# wpp-freela

Lê suas conversas no **freelancer.com.br** (Chrome em debug, já logado) e manda WhatsApp
pros clientes pela Evolution API do Publiva — semi-automático, você escolhe e confirma cada um.

## Rodar

Dê dois cliques em **`start.bat`**. Ele abre o Chrome em debug (perfil `%LOCALAPPDATA%\Publiva\chrome-rpa`)
se ainda não estiver aberto, liga o Ollama e sobe o painel em http://localhost:3737.

Requer Node 22+ (sem `npm install`) e `.env` com `EVOLUTION_API_KEY` (SSM `/publiva/evolution/apikey`).

## As 3 etapas

1. **Scanner** — numa aba só dele, abre a caixa de mensagens do site (não a pasta Arquivado de lá), aperta **Próximo** até a última página,
   abre cada conversa e lê: o que o cliente disse, o telefone (escrito pelo cliente ou liberado pelo site
   quando ele não responde) e o projeto (orçamento, descrição). *Escanear (novidades)* para na primeira
   página sem mudança; *Escanear tudo* vai até o fim. Salva a cada lote em `data/indice.json`.
   Não precisa ficar olhando — pode usar o PC.
2. **Selecionar** — lista filtrável (respondeu / contato liberado / aguardando / importados, só com WhatsApp,
   esconder enviados, só quem já falei). Seleção por 7 dias, 30 dias, 3 meses, período ou todos.
   Mensagem por linha: *Minha msg* (modelo com `{nome}`, `{projeto}`, `{saudacao}`) ou *IA* (Ollama).
   Contato que já recebeu WhatsApp por outro projeto usa o modelo de retorno ("Opa, … vim de novo").
3. **Enviar** — um cliente por vez numa tela de revisão: fotos (site e WhatsApp), conversa do site,
   histórico do WhatsApp com o número, projetos anteriores, mensagem editável. Contagem regressiva
   (intervalo configurável) com **Enviar agora / Pausar / Pular / Parar**. Quem já recebeu ou já conversou
   começa **pausado**. Editar a mensagem também pausa.

Extras: **Projetos novos** (lê /projetos e envia *interesse* nos que você selecionar) e
**Importar JSON** (`[{ "numero", "nome", "projeto", "mensagem" }]` vira linha na etapa 2).

## Dados (`data/`, fora do git)

`indice.json` conversas · `contatos.json` número → nomes, e-mails, projetos, quando enviou ·
`enviados.json` · `rascunhos.json` · `whatsapp.json` (tem WhatsApp?) · `projetos-novos.json` · `interesses.json` · `config.json`

## Linha de comando (Evolution)

`npm run status` · `npm run conectar` · `npm run enviar -- <numero> "texto"` (só `DESTINOS_PERMITIDOS`; no painel quem decide é você na revisão).
