/**
 * Painel local: conversas do freelancer.com.br → mensagem → WhatsApp (Evolution),
 * e projetos novos → interesse. Semi-automático: nada sai sem você selecionar e clicar.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import * as evo from "./evolution.mjs";
import * as freela from "./freela.mjs";
import * as ollama from "./ollama.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DADOS = resolve(RAIZ, "data");
mkdirSync(DADOS, { recursive: true });
const PORTA = Number(process.env.PORTA || 3737);

/** Lê data/<nome>; se estiver corrompido, usa a cópia anterior (.bak). */
function ler(nome, padrao) {
  for (const f of [resolve(DADOS, nome), resolve(DADOS, `${nome}.bak`)]) {
    if (!existsSync(f)) continue;
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      console.log(`${f} ilegível, tentando a cópia anterior`);
    }
  }
  return padrao;
}

/**
 * Gravação atômica: escreve em .tmp e troca de nome — um reinício no meio nunca deixa
 * o arquivo pela metade. A versão anterior fica em .bak.
 */
function gravarTexto(nome, texto) {
  const f = resolve(DADOS, nome);
  writeFileSync(`${f}.tmp`, texto);
  if (existsSync(f)) copyFileSync(f, `${f}.bak`);
  renameSync(`${f}.tmp`, f);
}
function gravar(nome, valor) {
  gravarTexto(nome, JSON.stringify(valor, null, 1));
}

const CONFIG_PADRAO = {
  minhaMsg:
    'Olá {nome}, {saudacao}! Aqui é o Gustavo, vi seu projeto "{projeto}" no Freelancer.com.br e posso te ajudar. Podemos falar sobre o projeto?',
  minhaMsgRetorno:
    'Opa {nome}, {saudacao}! Aqui é o Gustavo de novo (já conversamos sobre "{projetoAnterior}"). Vi que você publicou "{projeto}" no Freelancer.com.br e posso te ajudar nesse também. Podemos falar sobre o projeto?',
  msgInteresse: "Oi, Empregador,\n\nEu gostaria de entrar em contato com você a respeito deste projeto.\n\nAtenciosamente,\nGustavo",
  perfil:
    "Gustavo, desenvolvedor full-stack freelancer (remoto). Faz: sites e landing pages, sistemas web, apps, automações e robôs (RPA, scraping), integrações de APIs e pagamentos, bots de WhatsApp, chatbots e soluções com IA, dashboards. Não faz: vagas presenciais ou CLT, design gráfico puro, vídeo, redação, vendas, atendimento, tradução.",
  intervaloMin: 20,
  intervaloMax: 60,
};

const estado = {
  indice: ler("indice.json", {}), // conversas do freelancer.com.br
  importados: ler("importados.json", {}), // vindos de JSON
  enviados: ler("enviados.json", {}), // id → [{ numero, texto, quando }]
  rascunhos: ler("rascunhos.json", {}), // id → texto
  whats: ler("whatsapp.json", {}), // numero → true|false
  historico: ler("historico-whatsapp.json", {}), // numero → { tem, ultima } — já existe conversa no WhatsApp?
  analises: ler("analises.json", {}), // projetoId → { nota, motivo, mensagem, enviado } — IA em lotes
  iaLote: null,
  arquivados: ler("arquivados.json", {}), // id → { quando } — pasta "Arquivados" do painel (o site não é tocado)
  projetosNovos: ler("projetos-novos.json", { lidoEm: null, itens: [] }),
  interesses: ler("interesses.json", {}), // projetoId → { quando, ok, mensagem }
  config: { ...CONFIG_PADRAO, ...ler("config.json", {}) },
  scan: ler("scan.json", null), // { modo, pastas, fases } — onde cada fase parou
  rodando: null, // { desde, fase, msg, progresso }
  ultimoScan: null,
  lendoProjetos: null,
  interesseLote: null, // envio de interesse em todos: { rodando, feitos, total, ok, falhas, atual }
  salvo: null, // { quando, conversas, lidas, comTelefone } — última gravação em disco
};

/* ---------- contatos: número → projetos (salvo em data/contatos.json) ---------- */

function todosItens() {
  return [...Object.values(estado.indice), ...Object.values(estado.importados)];
}

function montarContatos() {
  const contatos = {};
  for (const i of todosItens()) {
    for (const n of i.telefones ?? []) {
      const c = (contatos[n] ??= { numero: n, nomes: [], emails: [], projetos: [] });
      for (const nome of [i.contatoNome, i.cliente]) if (nome && !c.nomes.includes(nome)) c.nomes.push(nome);
      if (i.email && !c.emails.includes(i.email)) c.emails.push(i.email);
      const env = (estado.enviados[i.id] ?? []).filter((e) => e.numero === n);
      c.projetos.push({
        id: i.id,
        projeto: i.projeto,
        projetoUrl: i.projetoUrl ?? null,
        conversa: i.url ?? null,
        quando: i.ts ? new Date(i.ts * 1000).toISOString() : null,
        enviadoEm: env.at(-1)?.quando ?? null,
      });
    }
  }
  gravar("contatos.json", contatos);
  gravarCsv();
  return contatos;
}

/** data/contatos.csv — uma linha por conversa com telefone, pra abrir no Excel a qualquer momento. */
function gravarCsv() {
  const cel = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/\s+/g, " ").trim()}"`;
  const linhas = [["data", "cliente", "contato", "telefone", "email", "situacao", "fonte", "projeto", "orcamento", "cliente disse", "conversa", "whatsapp enviado"]];
  const itens = todosItens().filter((i) => i.telefones?.length).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  for (const i of itens) {
    linhas.push([
      i.ts ? new Date(i.ts * 1000).toLocaleDateString("pt-BR") : "",
      i.cliente, i.contatoNome, i.telefones.join(" / "), i.email, i.situacao, i.fonteTelefone,
      i.projeto, i.projetoInfo?.orcamento, i.ultimaDoCliente, i.url,
      estado.enviados[i.id]?.at(-1)?.quando ?? "",
    ]);
  }
  // BOM + ";" pro Excel em português abrir certo
  gravarTexto("contatos.csv", "﻿" + linhas.map((l) => l.map(cel).join(";")).join("\r\n"));
}

/** Salva índice + posição do scan + contatos de uma vez (chamado a cada página/lote). */
function salvarProgresso() {
  gravar("indice.json", estado.indice);
  if (estado.scan) gravar("scan.json", estado.scan);
  contatos = montarContatos();
  const itens = Object.values(estado.indice);
  estado.salvo = {
    quando: Date.now(),
    conversas: itens.length,
    lidas: itens.filter((i) => i.lido).length,
    comTelefone: itens.filter((i) => i.telefones?.length).length,
  };
}
let contatos = montarContatos();

/** Projetos anteriores deste contato para os quais você já mandou WhatsApp. */
function jaFalamos(item) {
  const antes = [];
  for (const n of item.telefones ?? []) {
    for (const p of contatos[n]?.projetos ?? []) {
      if (p.id !== item.id && p.enviadoEm && !antes.some((a) => a.id === p.id)) antes.push(p);
    }
  }
  return antes.sort((a, b) => String(b.enviadoEm).localeCompare(String(a.enviadoEm)));
}

/* ---------- ações ---------- */

/* ---------- scanner: 3 fases separadas, cada uma retoma de onde parou ---------- */

const FASES = ["listar", "conversas", "projetos"];
const temProjeto = (i) => !!(i.projetoInfo?.descricao || i.projetoInfo?.orcamento);

function novoScan(modo) {
  return { modo, iniciado: new Date().toISOString(), pastas: {}, fases: Object.fromEntries(FASES.map((f) => [f, "pendente"])) };
}

function pendencias() {
  const itens = Object.values(estado.indice);
  const conversas = itens.filter((i) => !i.lido && i.url).length;
  const projetos = new Set(itens.filter((i) => i.lido && i.projetoUrl && !temProjeto(i)).map((i) => i.projetoUrl)).size;
  return { conversas, projetos };
}

function avisar(msg) {
  if (estado.rodando) estado.rodando.msg = msg;
}
freela.aoPrecisarLogin(avisar);

async function rodarFase(fase) {
  const scan = estado.scan;
  estado.rodando.fase = fase;
  estado.rodando.progresso = null;
  scan.fases[fase] = "rodando";
  gravar("scan.json", scan);

  if (fase === "listar") {
    // novidades: para na primeira página sem mudança; tudo: aperta Próximo até o fim
    const conhecidas = scan.modo === "tudo" || !Object.keys(estado.indice).length
      ? null
      : Object.fromEntries(Object.values(estado.indice).filter((i) => i.lido).map((i) => [i.id, i.lidoMsg ?? i.ultimaMsg]));
    let vistas = 0;
    await freela.faseListar(scan, {
      conhecidas,
      avisar: (m) => avisar(`${m} · ${vistas} conversas vistas`),
      aoPagina: async (cards) => {
        for (const card of cards) estado.indice[card.id] = freela.aplicarCard(estado.indice[card.id], card);
        vistas += cards.length;
        estado.rodando.progresso = { feitas: vistas, total: null }; // total de páginas só se sabe no fim
        salvarProgresso();
      },
    });
  }

  if (fase === "conversas") {
    const pendentes = Object.values(estado.indice).filter((i) => !i.lido && i.url).sort((a, b) => b.ts - a.ts);
    avisar(`${pendentes.length} conversas pra ler`);
    estado.rodando.progresso = { feitas: 0, total: pendentes.length };
    await freela.faseConversas(
      pendentes.map((i) => ({ id: i.id, url: i.url })),
      async (res, progresso) => {
        for (const [id, det] of Object.entries(res)) estado.indice[id] = freela.aplicarConversa(estado.indice[id], det);
        estado.rodando.progresso = progresso;
        avisar(`conversas ${progresso.feitas}/${progresso.total}`);
        salvarProgresso();
      },
      avisar,
    );
    contatos = montarContatos();
  }

  if (fase === "projetos") {
    const itens = Object.values(estado.indice);
    // projeto já lido em outra conversa: só copia
    const lidos = Object.fromEntries(itens.filter(temProjeto).map((i) => [i.projetoUrl, i.projetoInfo]));
    for (const i of itens) if (!temProjeto(i) && lidos[i.projetoUrl]) i.projetoInfo = lidos[i.projetoUrl];
    const urls = [...new Set(itens.filter((i) => i.projetoUrl && !temProjeto(i)).map((i) => i.projetoUrl))];
    avisar(`${urls.length} projetos pra ler`);
    estado.rodando.progresso = { feitas: 0, total: urls.length };
    await freela.faseProjetos(
      urls,
      async (res, progresso) => {
        for (const [url, info] of Object.entries(res)) {
          if (info.erro) continue;
          for (const i of Object.values(estado.indice)) if (i.projetoUrl === url) i.projetoInfo = info;
        }
        estado.rodando.progresso = progresso;
        avisar(`projetos ${progresso.feitas}/${progresso.total}`);
        salvarProgresso();
      },
      avisar,
    );
  }

  scan.fases[fase] = "ok";
  gravar("scan.json", scan);
}

/**
 * modo "novidades" | "tudo" começa um scan novo; "continuar" retoma o salvo.
 * `so` roda só uma fase.
 */
async function rodarScanner({ modo = "continuar", so = null } = {}) {
  if (estado.rodando) return;
  if (modo !== "continuar" || !estado.scan) estado.scan = novoScan(modo === "continuar" ? "novidades" : modo);
  estado.rodando = { desde: Date.now(), fase: null, msg: "", progresso: null };
  freela.pararScanner(false);
  try {
    for (const fase of so ? [so] : FASES) {
      if (!so && estado.scan.fases[fase] === "ok") continue;
      if (so === "listar") estado.scan.pastas = {}; // rodar a listagem de novo, do começo
      await rodarFase(fase);
    }
    await checarWhatsapp().catch((e) => console.log(`checagem WhatsApp: ${e.message}`));
    await checarHistorico().catch((e) => console.log(`histórico WhatsApp: ${e.message}`));
    estado.ultimoScan = { fim: Date.now(), erro: null };
  } catch (e) {
    const fase = estado.rodando.fase;
    if (fase) estado.scan.fases[fase] = `erro: ${e.message}`;
    gravar("scan.json", estado.scan);
    estado.ultimoScan = { fim: Date.now(), erro: `${fase}: ${e.message}` };
    console.log(`scanner (${fase}): ${e.message}`);
  } finally {
    salvarProgresso();
    contatos = montarContatos();
    estado.rodando = null;
  }
}

/** Já existe conversa no WhatsApp com algum número deste item? null = ainda não checado. */
function historicoDo(item) {
  const achados = (item.telefones ?? []).map((n) => estado.historico[n]).filter(Boolean);
  if (!achados.length) return null;
  const com = achados.filter((h) => h.tem).sort((a, b) => String(b.ultima).localeCompare(String(a.ultima)));
  return com[0] ?? { tem: false, ultima: null };
}

/** Pergunta à Evolution quais números do índice já têm conversa no WhatsApp. */
async function checarHistorico({ todos = false } = {}) {
  if ((await evo.estado()) !== "conectado") throw new Error("WhatsApp não está conectado — conecte pelo QR primeiro");
  const numeros = [...new Set(todosItens().flatMap((i) => i.telefones ?? []))].filter((n) => todos || !(n in estado.historico));
  Object.assign(estado.historico, await evo.historicoDeConversa(numeros));
  gravar("historico-whatsapp.json", estado.historico);
  const com = numeros.filter((n) => estado.historico[n]?.tem).length;
  return { checados: numeros.length, comHistorico: com };
}

async function checarWhatsapp() {
  if ((await evo.estado()) !== "conectado") return;
  const faltam = [...new Set(todosItens().flatMap((i) => i.telefones ?? []))].filter((n) => !(n in estado.whats));
  for (let i = 0; i < faltam.length; i += 50) {
    Object.assign(estado.whats, await evo.temWhatsapp(faltam.slice(i, i + 50)));
    gravar("whatsapp.json", estado.whats);
  }
}

function item(id) {
  const i = estado.indice[id] ?? estado.importados[id];
  if (!i) throw new Error("item não está no índice");
  return i;
}

async function gerarRascunho(id) {
  const it = item(id);
  let projeto = it.projetoInfo ?? {};
  if (!projeto.descricao && it.projetoUrl) projeto = await freela.detalheProjeto(it.projetoUrl);
  const texto = await ollama.rascunho(it, projeto, jaFalamos(it));
  estado.rascunhos[id] = texto;
  gravar("rascunhos.json", estado.rascunhos);
  return texto;
}

async function enviar(id, numero, texto) {
  item(id);
  if (!texto?.trim()) throw new Error("mensagem vazia");
  const destino = evo.normalizarNumero(numero);
  const { id: msgId } = await evo.enviarTexto(destino, texto.trim());
  (estado.enviados[id] ??= []).push({ numero: destino, texto: texto.trim(), quando: new Date().toISOString(), msgId });
  gravar("enviados.json", estado.enviados);
  estado.historico[destino] = { tem: true, ultima: new Date().toISOString() };
  gravar("historico-whatsapp.json", estado.historico);
  estado.rascunhos[id] = texto.trim();
  gravar("rascunhos.json", estado.rascunhos);
  contatos = montarContatos();
  return { destino };
}

/**
 * Página /clientes: todo número que já recebeu WhatsApp pelo painel + quem tem conversa no WhatsApp
 * e está nos contatos do site (ou mandou msg não lida). Cada um com os projetos/conversas do site e
 * as últimas mensagens do WhatsApp.
 */
async function clientesWhats() {
  if ((await evo.estado().catch(() => "")) !== "conectado") throw new Error("WhatsApp desconectado — conecte em /qr");
  const porChave = {}; // chaveNumero → cliente
  const pegar = (n) => (porChave[evo.chaveNumero(n)] ??= { numero: n, nomes: [], projetos: [], enviados: [] });
  for (const [id, envios] of Object.entries(estado.enviados)) {
    for (const e of envios) pegar(e.numero).enviados.push({ id, quando: e.quando, texto: e.texto });
  }
  const chats = await evo.conversas().catch(() => []);
  // o mesmo número pode ter 2 conversas (número@s.whatsapp.net e @lid): junta as duas
  const chatDe = {};
  for (const c of chats) {
    const j = (chatDe[evo.chaveNumero(c.numero)] ??= { numero: c.numero, jids: [], nome: null, naoLidas: 0 });
    j.jids.push(c.jid);
    j.nome ??= c.nome;
    j.naoLidas += c.naoLidas;
  }
  const contatoDe = Object.fromEntries(Object.values(contatos).map((c) => [evo.chaveNumero(c.numero), c]));
  for (const [k, c] of Object.entries(chatDe)) if (contatoDe[k] || c.naoLidas) pegar(c.numero);
  const lista = Object.entries(porChave).map(([k, cli]) => {
    const ct = contatoDe[k];
    const ids = new Set([...(ct?.projetos ?? []).map((p) => p.id), ...cli.enviados.map((e) => e.id)]);
    cli.nomes = ct?.nomes.filter((n) => n !== "Freelancer Plataforma") ?? [];
    cli.projetos = [...ids].map((id) => {
      const it = estado.indice[id] ?? estado.importados[id] ?? {};
      if (!cli.nomes.length && (it.contatoNome || it.cliente)) cli.nomes.push(it.contatoNome || it.cliente);
      return { id, projeto: it.projetoInfo?.titulo ?? it.projeto ?? "?", projetoUrl: it.projetoUrl ?? null, conversa: it.url ?? null, orcamento: it.projetoInfo?.orcamento ?? null, ts: it.ts ?? 0 };
    }).sort((a, b) => b.ts - a.ts);
    if (!cli.nomes.length && chatDe[k]?.nome) cli.nomes.push(chatDe[k].nome);
    cli.jids = chatDe[k]?.jids ?? [];
    cli.naoLidas = chatDe[k]?.naoLidas ?? 0;
    return cli;
  });
  for (let i = 0; i < lista.length; i += 5) {
    await Promise.all(lista.slice(i, i + 5).map(async (c) => { c.msgs = await evo.historico(c.numero, 15, c.jids).catch(() => []); }));
  }
  for (const c of lista) {
    const ult = c.msgs.at(-1);
    const minha = c.msgs.findLast((m) => m.deMim);
    c.novas = c.msgs.filter((m) => !m.deMim && (!minha || m.quando > minha.quando)).length;
    c.respondeu = c.msgs.some((m) => !m.deMim);
    c.status = !ult ? "sem conversa" : !ult.deMim ? "responder" : c.respondeu ? "aguardando" : "sem resposta";
    c.ultima = ult?.quando ?? c.enviados.at(-1)?.quando ?? null;
  }
  const ordem = { responder: 0, aguardando: 1, "sem resposta": 2, "sem conversa": 3 };
  return lista.sort((a, b) => ordem[a.status] - ordem[b.status] || String(b.ultima).localeCompare(String(a.ultima)));
}

/** JSON: [{ numero|telefone, mensagem?, nome?, projeto?, projetoUrl? }] ou { itens: [...] }. */
function importar(lista) {
  const arr = Array.isArray(lista) ? lista : (lista?.itens ?? lista?.contatos ?? []);
  let n = 0;
  for (const x of arr) {
    const tel = x.numero ?? x.telefone ?? x.whatsapp ?? x.phone;
    if (!tel) continue;
    let numero;
    try {
      numero = evo.normalizarNumero(tel);
    } catch {
      continue;
    }
    const id = `json-${numero}-${String(x.projeto ?? "").slice(0, 40)}`;
    estado.importados[id] = {
      id,
      importado: true,
      ts: Math.floor(Date.now() / 1000),
      cliente: x.nome ?? x.cliente ?? null,
      contatoNome: x.nome ?? null,
      projeto: x.projeto ?? "(importado)",
      projetoUrl: x.projetoUrl ?? x.url ?? null,
      projetoInfo: x.descricao ? { descricao: x.descricao } : null,
      telefones: [numero],
      situacao: "importado",
      conversa: [],
    };
    if (x.mensagem && !estado.rascunhos[id]) estado.rascunhos[id] = x.mensagem;
    n++;
  }
  gravar("importados.json", estado.importados);
  gravar("rascunhos.json", estado.rascunhos);
  contatos = montarContatos();
  checarWhatsapp().catch(() => {});
  return { importados: n };
}

/**
 * Lê /projetos. paginas = 0 → todas. Salva a cada página em projetos-novos.json;
 * com `continuar`, retoma da página seguinte à última lida (mesma busca, leitura incompleta).
 */
/**
 * Lê /projetos página a página, salvando a cada página (retoma de onde parou).
 * A lista salva NUNCA é apagada (só se mudar a busca): projetos novos entram, os já vistos ficam.
 * `novidades`: para depois de 3 páginas seguidas sem nenhum projeto novo (os novos aparecem no começo).
 */
// Projetos que não têm nada a ver com o perfil (vídeo, design, vendas, presencial…) nem entram na lista.
// Quem a IA já analisou: vale a nota dela. O resto: área do site, ou o título quando a área é outra.
const AREAS_MINHAS = /^(Softwares e sistemas|Site e aplicativos|Tecnologia e Ciência)/;
const AREAS_FORA = /Eletrônicos|Desenho técnico|Pesquisa científica|Robótica/;
const TITULO_MEU =
  /\bsites?\b|landing|sistema|\bapps?\b|aplicativo(?! de mensage)|automa[çt]|\brob[oô]s?\b|\bbots?\b|chat ?bot|\bapis?\b|integra[çc][ãa]o|scrap|extra[çt][ãaoõ]|extrator|dashboard|chat ?gpt|\bgpt|agentes? de ia|programa[çd]|software|wordpress|e-?commerce|loja virtual|n8n|python|javascript|typescript|node|react|flutter|php|laravel|banco de dados|planilha|excel|crm\b|erp\b|power ?bi|\bweb\b|full ?stack|front-?end|back-?end|desenvolvedor|unreal|unity/i;
const TITULO_FORA =
  /v[ií]deo|reels|grava[çc]|editor|design|logo|banner|identidade visual|personage|ilustra|imagem|motion|anima[çc]|treinamento|especialista em|vendedor|vendas|prospec|\bsdr\b|atendimento|atendente|assistente|divulga|social ?m[ií]dia|tr[áa]fego|livro|curso|professor|aula|semin[áa]rio|acad[êe]mico|est[áa]gio|copywrit|reda[çc]|tradu|locu[çc]|m[úu]sic|par[óo]dia|apresenta[çc]|powerpoint|el[ée]tric|t[ée]cnico|disparo/i;
function combinaComigo(p) {
  const an = estado.analises[p.id];
  if (typeof an?.encaixa === "boolean") return an.encaixa;
  if (!/remot/i.test(p.local ?? "Remoto")) return false;
  if (AREAS_MINHAS.test(p.categoria ?? "")) return !AREAS_FORA.test(p.categoria);
  return TITULO_MEU.test(p.titulo ?? "") && !TITULO_FORA.test(p.titulo ?? "");
}
/** Apaga da lista salva o que não combina. Devolve quantos saíram. */
function limparProjetos() {
  const pn = estado.projetosNovos;
  const antes = pn.itens.length;
  pn.itens = pn.itens.filter(combinaComigo);
  if (pn.itens.length !== antes) gravar("projetos-novos.json", pn);
  return antes - pn.itens.length;
}

async function lerProjetosNovos(paginas, busca = "", { continuar = false, novidades = false, parar = () => false, aoNovos = () => {} } = {}) {
  if (estado.lendoProjetos && !estado.lendoProjetos.erro) return;
  const pn = estado.projetosNovos;
  const retoma = continuar && !pn.completo && (pn.busca ?? "") === busca && pn.pagina > 0;
  if (!retoma) {
    const mesmaBusca = (pn.busca ?? "") === busca;
    estado.projetosNovos = { lidoEm: pn.lidoEm ?? null, busca, itens: mesmaBusca ? pn.itens ?? [] : [], pagina: 0, completo: false, totalPaginas: mesmaBusca ? pn.totalPaginas ?? null : null };
  }
  let semNovos = 0;
  const pararTudo = () => parar() || (novidades && semNovos >= 3);
  const alvo = estado.projetosNovos;
  const porId = new Map(alvo.itens.map((p) => [p.id, p]));
  // quantas páginas tem: o site não diz, então usa quantas tinha na última leitura completa (estimativa)
  const estimado = !paginas && !novidades && alvo.totalPaginas ? alvo.totalPaginas : null;
  estado.lendoProjetos = { desde: Date.now(), pagina: alvo.pagina, projetos: alvo.itens.length, ate: paginas || estimado, estimado: !!estimado, novidades };
  try {
    await freela.listarProjetos(paginas, busca, {
      deP: alvo.pagina + 1,
      parar: pararTudo,
      aoPagina: (todos, p) => {
        const cards = todos.filter(combinaComigo);
        semNovos = cards.some((k) => !porId.has(k.id)) ? 0 : semNovos + 1;
        for (const k of cards) {
          const velho = porId.get(k.id);
          porId.set(k.id, { ...k, jaInteressado: k.jaInteressado || !!velho?.jaInteressado || !!estado.interesses[k.id]?.ok });
        }
        alvo.itens = [...porId.values()];
        alvo.pagina = p;
        alvo.lidoEm = new Date().toISOString();
        estado.lendoProjetos.pagina = p;
        estado.lendoProjetos.projetos = alvo.itens.length;
        gravar("projetos-novos.json", alvo);
        aoNovos(cards.map((k) => porId.get(k.id))); // quem capta avisa quem envia
      },
    });
    if (!parar()) {
      alvo.completo = true;
      if (!novidades && !paginas) alvo.totalPaginas = alvo.pagina; // leu até a última página de verdade
    }
    alvo.lidoEm = new Date().toISOString();
    gravar("projetos-novos.json", alvo);
    estado.lendoProjetos = null;
  } catch (e) {
    estado.lendoProjetos = { erro: `${e.message} (parou na página ${alvo.pagina} — dá pra continuar)` };
  }
}

async function enviarInteresse(projetoId, mensagem) {
  const p = estado.projetosNovos.itens.find((x) => x.id === projetoId);
  if (!p) throw new Error("projeto não está na lista");
  const r = await freela.enviarInteresse(p.url, mensagem || estado.config.msgInteresse);
  // sem o botão "Estou interessado" (vaga de outro tipo / fechado): marca pra nunca mais tentar
  const semBotao = !r.ok && /não achei o botão/.test(r.resposta ?? "");
  estado.interesses[projetoId] = { quando: new Date().toISOString(), ok: r.ok, jaEstava: !!r.jaEstava, semBotao, titulo: p.titulo, url: p.url };
  gravar("interesses.json", estado.interesses);
  if (r.ok) p.jaInteressado = true;
  gravar("projetos-novos.json", estado.projetosNovos);
  if (!r.ok && r.temporario) throw Object.assign(new Error(r.resposta), { temporario: true });
  if (!r.ok) throw new Error(`o site não confirmou o interesse: ${r.resposta ?? ""}`);
  return r;
}

/**
 * Captar e enviar, em paralelo:
 *   - 1 aba capta /projetos página a página (mais novos primeiro) e joga os abertos numa fila;
 *   - N abas (padrão 4) pegam da fila e mandam o interesse, cada uma com sua pausa aleatória.
 * Começa já enviando o que está na lista salva. Salva em lote-interesse.json e retoma no reinício.
 * Para sozinho com 5 falhas seguidas (limite do plano?); site fora do ar só espera e tenta de novo.
 */
async function interesseEmTodos({ mensagem, min = 15, max = 40, escanear = true, paginas = 0, abas = 4 } = {}, anterior = null) {
  if (estado.interesseLote?.rodando) return estado.interesseLote;
  if (estado.iaLote?.rodando) throw new Error("a IA em lotes está rodando — pare ela antes");
  abas = Math.max(1, Math.min(8, Number(abas) || 4));
  const params = { mensagem, min, max, escanear, paginas, abas };
  const lote = (estado.interesseLote = {
    rodando: true, desde: anterior?.desde ?? Date.now(), fase: "captando e enviando", feitos: 0,
    ok: anterior?.ok ?? 0, falhas: anterior?.falhas ?? 0, total: 0, naFila: 0, atual: "", parar: false,
    erros: anterior?.erros?.slice(-20) ?? [], params, retomado: !!anterior, abas: {},
  });
  const salvarLote = () => gravar("lote-interesse.json", lote);
  salvarLote();

  const pendente = (p) =>
    p && !p.jaInteressado && !estado.interesses[p.id]?.ok && !estado.interesses[p.id]?.semBotao && !/fechad|cancelad/i.test(p.status ?? "");
  const fila = [];
  const vistos = new Set();
  const enfileirar = (lista) => {
    for (const p of lista) {
      if (!pendente(p) || vistos.has(p.id)) continue;
      vistos.add(p.id);
      fila.push(p);
      lote.total++;
    }
    lote.naFila = fila.length;
  };
  let captando = escanear;
  let seguidas = 0;
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));

  async function enviarUm(p, aba) {
    // site fora do ar: espera 1 min e tenta o MESMO projeto de novo (não conta como falha)
    for (let t = 0; ; t++) {
      try {
        const r = await freela.enviarInteresse(p.url, mensagem || estado.config.msgInteresse, { aba });
        const semBotao = !r.ok && /não achei o botão/.test(r.resposta ?? "");
        estado.interesses[p.id] = { quando: new Date().toISOString(), ok: r.ok, jaEstava: !!r.jaEstava, semBotao, titulo: p.titulo, url: p.url };
        gravar("interesses.json", estado.interesses);
        if (r.ok) p.jaInteressado = true;
        if (r.ok) return;
        if (r.temporario) throw Object.assign(new Error(r.resposta), { temporario: true });
        throw Object.assign(new Error(r.resposta ?? "o site não confirmou"), { semBotao });
      } catch (e) {
        if (!e.temporario || t >= 9 || lote.parar) throw e;
        for (let r = 60; r > 0 && !lote.parar; r--) {
          lote.abas[aba] = `site fora do ar — tentando de novo em ${r}s [${t + 1}/10]`;
          await dorme(1000);
        }
      }
    }
  }

  async function trabalhador(aba) {
    await dorme((aba - 1) * 4000); // não abre as 4 abas no mesmo segundo
    while (!lote.parar) {
      const p = fila.shift();
      lote.naFila = fila.length;
      if (!p) {
        if (!captando) break; // lista acabou e ninguém mais está captando
        lote.abas[aba] = "esperando a captação…";
        await dorme(2000);
        continue;
      }
      if (!pendente(p)) continue; // outra aba já resolveu
      lote.abas[aba] = p.titulo;
      let semBotao = false;
      try {
        await enviarUm(p, aba);
        lote.ok++;
        seguidas = 0;
      } catch (e) {
        lote.falhas++;
        semBotao = !!e.semBotao;
        if (!e.semBotao) seguidas++; // sem botão é do projeto, não limite do plano
        lote.erros.push(`${p.titulo}: ${e.message}`);
        if (lote.erros.length > 50) lote.erros.shift();
        if (seguidas >= 5) {
          lote.parar = true;
          lote.atual = `parou: 5 falhas seguidas — ${e.message}`;
        }
      }
      lote.feitos++;
      salvarLote();
      if (semBotao) continue; // nada foi enviado: não precisa da pausa (lista velha tem muito projeto fechado)
      const s = Math.round(min + Math.random() * Math.max(0, max - min));
      for (let r = s; r > 0 && !lote.parar; r--) {
        lote.abas[aba] = `próximo em ${r}s`;
        await dorme(1000);
      }
    }
    lote.abas[aba] = "parada";
  }

  async function captar() {
    try {
      // já tem captação rodando (a do início): só vai pegando o que ela traz
      while (estado.lendoProjetos && !estado.lendoProjetos.erro && !lote.parar) {
        enfileirar(estado.projetosNovos.itens);
        await dorme(3000);
      }
      enfileirar(estado.projetosNovos.itens);
      if (estado.projetosNovos.completo && Date.now() - Date.parse(estado.projetosNovos.lidoEm ?? 0) < 10 * 60_000) return;
      const novidades = !!estado.projetosNovos.completo; // lista já toda lida: só os novos
      // página 1 = mais novos; a lista inteira é relida (novos projetos entram, fechados saem)
      await lerProjetosNovos(paginas, estado.projetosNovos.busca ?? "", {
        continuar: !estado.projetosNovos.completo,
        novidades,
        parar: () => lote.parar,
        aoNovos: enfileirar,
      });
      if (estado.lendoProjetos?.erro) lote.erros.push(`captação: ${estado.lendoProjetos.erro}`);
    } finally {
      captando = false;
    }
  }

  try {
    enfileirar(estado.projetosNovos.itens); // já começa com o que estava salvo
    lote.atual = `captando /projetos e enviando com ${abas} abas`;
    await Promise.all([captando ? captar() : null, ...Array.from({ length: abas }, (_, k) => trabalhador(k + 1))]);
    if (!lote.atual.startsWith("parou")) lote.atual = lote.parar ? "parado" : "terminado";
  } catch (e) {
    lote.atual = `erro: ${e.message}`;
  } finally {
    lote.rodando = false;
    lote.fim = Date.now();
    salvarLote();
  }
  return lote;
}

/**
 * IA em lotes (Ollama), uma aba, no ritmo de uma pessoa:
 *   analisa 10 projetos (abre cada um, lê a descrição, o Ollama dá nota 0-10 + mensagem)
 *   → manda interesse nos que tiveram nota ≥ notaMin, com a mensagem da IA
 *   → próximos 10 … (capta mais páginas de /projetos quando a lista acaba).
 * Análises em analises.json, estado em lote-ia.json (retoma no reinício).
 */
/** `enviar: false` = só analisa (o que roda sozinho no início); os bons ficam pra quando você clicar Iniciar. */
async function iaEmLotes({ tamanho = 10, notaMin = 6, min = 20, max = 50, perfil, enviar = true } = {}, anterior = null) {
  if (estado.iaLote?.rodando) return estado.iaLote;
  if (estado.interesseLote?.rodando) throw new Error("o \"Captar e enviar\" está rodando — pare ele antes");
  tamanho = Math.max(1, Math.min(50, Number(tamanho) || 10));
  notaMin = Math.max(0, Math.min(10, Number(notaMin) || 6));
  perfil = (perfil || estado.config.perfil || "").trim();
  const params = { tamanho, notaMin, min, max, perfil };
  const lote = (estado.iaLote = {
    rodando: true, enviar, progresso: null, desde: anterior?.desde ?? Date.now(), fase: "", rodada: anterior?.rodada ?? 0,
    analisados: anterior?.analisados ?? 0, enviados: anterior?.enviados ?? 0, descartados: anterior?.descartados ?? 0,
    falhas: anterior?.falhas ?? 0, atual: "", parar: false, params, retomado: !!anterior, erros: anterior?.erros?.slice(-20) ?? [],
  });
  const salvar = () => gravar("lote-ia.json", lote);
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const pausa = async (rotulo) => {
    const s = Math.round(min + Math.random() * Math.max(0, max - min));
    for (let r = s; r > 0 && !lote.parar; r--) {
      lote.atual = `${rotulo} em ${r}s`;
      await dorme(1000);
    }
  };
  // mesmo projeto não é analisado duas vezes; nem os que já têm interesse
  const pendente = (p) =>
    p && !p.jaInteressado && !estado.interesses[p.id]?.ok && !estado.interesses[p.id]?.semBotao &&
    !estado.analises[p.id] && !/fechad|cancelad/i.test(p.status ?? "");
  // analisados que encaixaram e ainda não foram (inclusive os da análise do início, que não envia)
  const aEnviar = () =>
    estado.projetosNovos.itens.filter((p) => {
      const an = estado.analises[p.id];
      return an?.encaixa && an.mensagem && !an.enviado && !an.erroEnvio && !p.jaInteressado && !estado.interesses[p.id]?.ok;
    });
  salvar();
  try {
    while (!lote.parar) {
      let proximos = estado.projetosNovos.itens.filter(pendente).slice(0, tamanho);
      const captandoOutro = estado.lendoProjetos && !estado.lendoProjetos.erro;
      if (captandoOutro && !proximos.length) {
        // a captação está rodando em paralelo: espera ela trazer mais projetos
        lote.fase = "esperando";
        lote.progresso = null;
        lote.atual = `esperando a captação de /projetos (${estado.projetosNovos.itens.length} lidos)…`;
        await dorme(3000);
        continue;
      }
      if (proximos.length < tamanho && !enviar && estado.projetosNovos.completo) {
        // só analisando: a lista toda já foi lida, analisa o resto e termina
      } else if (proximos.length < tamanho && !captandoOutro) {
        // lista acabando: capta mais 5 páginas de /projetos (lista toda lida → volta pras mais novas)
        const pn = estado.projetosNovos;
        const continuar = !pn.completo && (pn.pagina || 0) > 0;
        const ate = continuar ? pn.pagina + 5 : 5;
        lote.fase = "captando";
        lote.atual = `lendo /projetos até a página ${ate}…`;
        await lerProjetosNovos(ate, pn.busca ?? "", { continuar, parar: () => lote.parar });
        proximos = estado.projetosNovos.itens.filter(pendente).slice(0, tamanho);
      }
      if (!proximos.length && !(enviar && aEnviar().length)) {
        lote.atual = "terminado: não há mais projetos pra analisar";
        break;
      }
      lote.rodada++;

      // 1) analisa os N
      lote.fase = "analisando";
      for (const [k, p] of proximos.entries()) {
        if (lote.parar) break;
        lote.progresso = { feitas: k, total: proximos.length };
        lote.atual = `rodada ${lote.rodada} — analisando ${k + 1}/${proximos.length}: ${p.titulo}`;
        try {
          let info = await freela.lerProjetoNavegando(p.url);
          for (let t = 0; info.temporario && t < 5 && !lote.parar; t++) {
            lote.atual = `${info.erro} — tentando de novo em 60s`;
            await dorme(60_000);
            info = await freela.lerProjetoNavegando(p.url);
          }
          if (info.temporario) throw new Error(info.erro);
          if (info.jaInteressado) {
            p.jaInteressado = true;
            estado.analises[p.id] = { quando: new Date().toISOString(), titulo: p.titulo, url: p.url, pulado: "já tinha interesse" };
            continue;
          }
          if (!info.podeEnviar) {
            estado.analises[p.id] = { quando: new Date().toISOString(), titulo: p.titulo, url: p.url, pulado: "sem botão de interesse" };
            continue;
          }
          const a = await ollama.analisarProjeto({ ...p, ...info, titulo: info.titulo || p.titulo }, perfil);
          estado.analises[p.id] = { quando: new Date().toISOString(), titulo: p.titulo, url: p.url, orcamento: info.orcamento ?? p.orcamento, ...a, encaixa: a.nota >= notaMin };
          lote.analisados++;
          if (!(a.nota >= notaMin && a.mensagem)) lote.descartados++;
        } catch (e) {
          lote.falhas++;
          lote.erros.push(`analisar ${p.titulo}: ${e.message}`);
          estado.analises[p.id] = { quando: new Date().toISOString(), titulo: p.titulo, url: p.url, erro: e.message };
        } finally {
          gravar("analises.json", estado.analises);
          salvar();
        }
        if (k < proximos.length - 1 && !lote.parar) await dorme(2000 + Math.random() * 3000); // lendo como gente
      }

      limparProjetos(); // os que a IA disse que não encaixam saem da lista
      lote.progresso = { feitas: proximos.length, total: proximos.length };
      if (!enviar) continue; // só análise: segue pros próximos, sem pausa de envio

      // 2) manda interesse nos que encaixaram, com a mensagem da IA
      lote.fase = "enviando";
      const bons = aEnviar();
      for (const [k, p] of bons.entries()) {
        if (lote.parar) break;
        lote.progresso = { feitas: k, total: bons.length };
        const an = estado.analises[p.id];
        lote.atual = `rodada ${lote.rodada} — enviando ${k + 1}/${bons.length}: ${p.titulo} (nota ${an.nota})`;
        try {
          const r = await freela.enviarInteresse(p.url, an.mensagem, { aba: 1 });
          // o site bloqueou a conta (excesso de envios): para tudo e não queima a mensagem pronta
          if (!r.ok && (r.desligado || /não é permitido/i.test(r.resposta ?? ""))) {
            lote.parar = lote.bloqueado = true;
            lote.erros.push(`enviar ${p.titulo}: ${r.resposta}`);
            lote.atual = `o site está bloqueando os envios ("não é permitido") — ${aEnviar().length} mensagens prontas ficam guardadas`;
            break;
          }
          estado.interesses[p.id] = { quando: new Date().toISOString(), ok: r.ok, jaEstava: !!r.jaEstava, titulo: p.titulo, url: p.url, ia: true, nota: an.nota };
          gravar("interesses.json", estado.interesses);
          an.enviado = r.ok;
          if (r.ok) {
            p.jaInteressado = true;
            lote.enviados++;
          } else {
            an.erroEnvio = r.resposta;
            lote.falhas++;
            lote.erros.push(`enviar ${p.titulo}: ${r.resposta}`);
          }
        } catch (e) {
          lote.falhas++;
          lote.erros.push(`enviar ${p.titulo}: ${e.message}`);
          an.erroEnvio = e.message;
        } finally {
          gravar("analises.json", estado.analises);
          salvar();
        }
        if (k < bons.length - 1 && !lote.parar) await pausa("próximo envio");
      }
      if (lote.erros.length > 50) lote.erros = lote.erros.slice(-50);
      if (!lote.parar) await pausa("próxima rodada");
    }
    if (lote.parar && !lote.bloqueado) lote.atual = "parado";
  } catch (e) {
    lote.atual = `erro: ${e.message}`;
  } finally {
    lote.rodando = false;
    lote.fim = Date.now();
    salvar();
  }
  return lote;
}

/** Tudo que já foi feito com interesses (data/interesses.json — nunca é apagado, nunca repete). */
function resumoInteresses() {
  const v = Object.values(estado.interesses);
  const hoje = new Date().toDateString();
  const ok = v.filter((x) => x.ok);
  const pn = estado.projetosNovos;
  const pendentes = pn.itens.filter(
    (p) => !p.jaInteressado && !estado.interesses[p.id]?.ok && !estado.interesses[p.id]?.semBotao && !/fechad|cancelad/i.test(p.status ?? ""),
  ).length;
  return {
    enviados: ok.length,
    hoje: ok.filter((x) => new Date(x.quando).toDateString() === hoje).length,
    semBotao: v.filter((x) => x.semBotao).length,
    falhas: v.filter((x) => !x.ok && !x.semBotao).length,
    pendentes,
    lista: { projetos: pn.itens.length, pagina: pn.pagina, completo: !!pn.completo, lidoEm: pn.lidoEm, totalPaginas: pn.totalPaginas ?? null },
    ultimos: ok.sort((a, b) => String(b.quando).localeCompare(String(a.quando))).slice(0, 15).map((x) => ({ titulo: x.titulo, quando: x.quando, url: x.url ?? null, ia: !!x.ia })),
  };
}

/**
 * Uma linha por processo pra barra do painel. `total: null` = sem máximo conhecido (barra vai-e-vem).
 */
function processos() {
  const lista = [];
  const r = estado.rodando;
  if (r) {
    const pr = r.progresso;
    const nomeFase = { listar: "listando conversas", conversas: "lendo conversas", projetos: "lendo projetos das conversas" }[r.fase] ?? "começando";
    lista.push({ id: "scanner", nome: "Scanner (caixa de mensagens)", feitas: pr?.feitas ?? 0, total: pr?.total || null, texto: `${nomeFase}${r.msg ? ` · ${r.msg}` : ""}` });
  }
  const lp = estado.lendoProjetos;
  if (lp && !lp.erro) lista.push({ id: "captacao", nome: "Captação /projetos", feitas: lp.pagina ?? 0, total: lp.ate, texto: lp.novidades ? `buscando projetos novos · página ${lp.pagina ?? 0} (para após 3 páginas sem novidade) · ${lp.projetos ?? 0} projetos` : `página ${lp.pagina ?? 0}${lp.ate ? ` de ${lp.estimado ? "~" : ""}${lp.ate} · faltam ${lp.estimado ? "~" : ""}${Math.max(0, lp.ate - (lp.pagina ?? 0))} páginas` : " · total de páginas ainda desconhecido"} · ${lp.projetos ?? 0} projetos` });
  const ia = estado.iaLote;
  if (ia?.rodando) {
    const pr = ia.progresso;
    lista.push({ id: "ia", nome: ia.enviar === false ? "IA analisando (sem enviar)" : "IA em lotes", feitas: pr?.feitas ?? 0, total: pr?.total || null, texto: `${ia.atual || ia.fase || "começando"} · ${ia.analisados} analisados` });
  }
  const lt = estado.interesseLote;
  if (lt?.rodando) lista.push({ id: "interesses", nome: "Captar e enviar", feitas: lt.feitos, total: lp && !lp.erro ? null : lt.total || null, texto: `${lt.ok} enviados · ${lt.naFila ?? 0} na fila · ${lt.falhas} falhas` });
  return lista;
}

/* ---------- HTTP ---------- */

async function corpo(req) {
  let s = "";
  for await (const pedaco of req) s += pedaco;
  return s ? JSON.parse(s) : {};
}

function json(res, status, dado) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(dado));
}

const rotas = {
  "GET /": (req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(resolve(RAIZ, "src/painel.html")));
  },
  "GET /clientes": (req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(resolve(RAIZ, "src/clientes.html")));
  },
  "GET /api/clientes": async () => ({ clientes: await clientesWhats(), lidoEm: new Date().toISOString() }),
  "GET /contatos.csv": (req, res) => {
    gravarCsv();
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="contatos.csv"' });
    res.end(readFileSync(resolve(DADOS, "contatos.csv")));
  },
  "GET /api/dados": async () => {
    let whatsapp;
    try {
      whatsapp = await evo.estado();
    } catch (e) {
      whatsapp = `erro: ${e.message}`;
    }
    const itens = todosItens().map((i) => ({
      ...i,
      rascunho: estado.rascunhos[i.id] ?? null,
      enviados: estado.enviados[i.id] ?? [],
      jaFalamos: jaFalamos(i),
      whats: Object.fromEntries((i.telefones ?? []).map((n) => [n, estado.whats[n] ?? null])),
      historico: historicoDo(i),
      arquivado: !!estado.arquivados[i.id],
    }));
    return {
      whatsapp,
      processos: processos(),
      resumo: resumoInteresses(),
      scanner: { rodando: estado.rodando, scan: estado.scan, ultimo: estado.ultimoScan, pendentes: pendencias(), salvo: estado.salvo },
      config: estado.config,
      itens,
      projetosNovos: {
        ...estado.projetosNovos,
        lendo: estado.lendoProjetos,
        lote: estado.interesseLote,
        ia: estado.iaLote,
        analises: Object.entries(estado.analises).sort((a, b) => String(b[1].quando).localeCompare(String(a[1].quando))).slice(0, 60).map(([id, a]) => ({ id, ...a })),
        itens: estado.projetosNovos.itens.map((p) => ({ ...p, interesse: estado.interesses[p.id] ?? null })),
      },
    };
  },
  "POST /api/scanner-parar": async () => {
    freela.pararScanner(true);
    if (estado.rodando) estado.rodando.msg = "parando… (termina a página/lote atual)";
    return { ok: true };
  },
  // para TUDO: scanner + lote de interesses
  "POST /api/parar-tudo": async () => {
    freela.pararScanner(true);
    if (estado.iaLote) {
      estado.iaLote.parar = true;
      if (estado.iaLote.rodando) estado.iaLote.atual = "parando…";
      gravar("lote-ia.json", estado.iaLote);
    }
    if (estado.rodando) estado.rodando.msg = "parando…";
    if (estado.interesseLote) {
      estado.interesseLote.parar = true;
      if (estado.interesseLote.rodando) estado.interesseLote.atual = "parando…";
      gravar("lote-interesse.json", estado.interesseLote);
    }
    return { ok: true };
  },
  "POST /api/scanner": async (req) => {
    const { modo = "continuar", so = null } = await corpo(req);
    if (so && !FASES.includes(so)) throw new Error("fase inválida");
    rodarScanner({ modo, so });
    return { ok: true };
  },
  // página só com o QR do WhatsApp: recarrega a cada 30 s (o QR vence) até conectar
  "GET /qr": async (req, res) => {
    let corpoHtml;
    try {
      if ((await evo.estado()) === "conectado") corpoHtml = "<h1>WhatsApp conectado ✓</h1><p>Pode fechar esta aba.</p>";
      else {
        const { qrBase64, codigo } = await evo.conectar();
        corpoHtml = `<h1>Escaneie no WhatsApp</h1><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p>
          ${qrBase64 ? `<img src="data:image/png;base64,${qrBase64}" width="360" height="360">` : ""}
          ${codigo ? `<p>ou use o código: <b>${codigo}</b></p>` : ""}
          <p style="color:#666">troca sozinho a cada 30 s</p><script>setTimeout(() => location.reload(), 30000)</script>`;
      }
    } catch (e) {
      corpoHtml = `<h1>Erro</h1><p>${String(e.message).replace(/</g, "&lt;")}</p><script>setTimeout(() => location.reload(), 10000)</script>`;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>WhatsApp QR</title><body style="font-family:sans-serif;text-align:center;padding:40px;background:#fff">${corpoHtml}</body>`);
  },
  "POST /api/conectar": async () => {
    if ((await evo.estado()) === "conectado") return { conectado: true };
    const { qrBase64, codigo } = await evo.conectar();
    return { qr: qrBase64 ? `data:image/png;base64,${qrBase64}` : null, codigo };
  },
  "POST /api/checar-whatsapp": async () => {
    await checarWhatsapp();
    return { ok: true };
  },
  "POST /api/checar-historico": async () => checarHistorico({ todos: true }),
  // ▶ play: você abriu o WhatsApp na mão com a mensagem pronta — registra pra sair do "não mandei"
  // pasta Arquivados (só no painel): arquivar/desarquivar uma lista de ids
  "POST /api/arquivar": async (req) => {
    const { ids = [], arquivar = true } = await corpo(req);
    for (const id of ids) {
      if (arquivar) estado.arquivados[id] = { quando: new Date().toISOString() };
      else delete estado.arquivados[id];
    }
    gravar("arquivados.json", estado.arquivados);
    return { ok: true, total: Object.keys(estado.arquivados).length };
  },
  // arquiva tudo que é de antes de `antesDe` e nunca recebeu WhatsApp
  "POST /api/arquivar-antigos": async (req) => {
    const { antesDe } = await corpo(req);
    const limite = new Date(antesDe).getTime() / 1000;
    if (!Number.isFinite(limite)) throw new Error("data inválida");
    let n = 0;
    for (const i of todosItens()) {
      if ((i.ts ?? 0) < limite && !(estado.enviados[i.id] ?? []).length && !estado.arquivados[i.id]) {
        estado.arquivados[i.id] = { quando: new Date().toISOString(), auto: true };
        n++;
      }
    }
    gravar("arquivados.json", estado.arquivados);
    return { arquivados: n, total: Object.keys(estado.arquivados).length };
  },
  "POST /api/marcar-manual": async (req) => {
    const { id, numero, texto } = await corpo(req);
    item(id);
    const destino = evo.normalizarNumero(numero);
    (estado.enviados[id] ??= []).push({ numero: destino, texto: String(texto ?? "").trim(), quando: new Date().toISOString(), manual: true });
    gravar("enviados.json", estado.enviados);
    contatos = montarContatos();
    return { ok: true };
  },
  // quanto do histórico do WhatsApp já chegou na Evolution (a barra acompanha isso)
  "GET /api/historico-status": async () => {
    if ((await evo.estado().catch(() => "")) !== "conectado") return { conectado: false };
    const c = await evo.contagemHistorico();
    const nossos = new Set([...new Set(todosItens().flatMap((i) => i.telefones ?? []))].map(evo.chaveNumero));
    return { conectado: true, ...c, dosClientes: c.chaves.filter((k) => nossos.has(k)).length, chaves: undefined, totalClientes: nossos.size };
  },
  "POST /api/rascunho": async (req) => {
    const { id } = await corpo(req);
    return { texto: await gerarRascunho(id) };
  },
  "POST /api/enviar": async (req) => {
    const { id, numero, texto } = await corpo(req);
    return enviar(id, numero, texto);
  },
  "POST /api/config": async (req) => {
    Object.assign(estado.config, await corpo(req));
    gravar("config.json", estado.config);
    return estado.config;
  },
  "POST /api/salvar-rascunho": async (req) => {
    const { id, texto } = await corpo(req);
    estado.rascunhos[id] = texto;
    gravar("rascunhos.json", estado.rascunhos);
    return { ok: true };
  },
  // tela de revisão antes de cada envio: foto e histórico do WhatsApp com o número
  "POST /api/revisar": async (req) => {
    const { id, numero } = await corpo(req);
    const it = item(id);
    const n = numero || it.telefones?.[0];
    const [foto, historico] = n && (await evo.estado().catch(() => "")) === "conectado"
      ? await Promise.all([evo.fotoPerfil(n).catch(() => null), evo.historico(n).catch(() => [])])
      : [null, []];
    return { numero: n, fotoWhats: foto, historicoWhats: historico, jaFalamos: jaFalamos(it) };
  },
  "POST /api/abrir-no-chrome": async (req) => {
    const { url } = await corpo(req);
    if (!/^https:\/\/freelancer\.com\.br\//.test(url ?? "")) throw new Error("só abro páginas do freelancer.com.br");
    await freela.mostrarNoChrome(url);
    return { ok: true };
  },
  "POST /api/importar": async (req) => importar(await corpo(req)),
  "POST /api/projetos": async (req) => {
    const { paginas = 5, busca = "", continuar = false } = await corpo(req);
    lerProjetosNovos(Math.max(0, Number(paginas) || 0), busca, { continuar: !!continuar }); // 0 = todas
    return { ok: true };
  },
  // fila do enviador (etapa 3) salva em disco: recarregar/fechar o painel não perde onde parou
  "GET /api/fila": async () => ler("fila-envio.json", { fila: [], pos: 0, resultado: {} }),
  "POST /api/fila": async (req) => {
    const { fila = [], pos = 0, resultado = {} } = await corpo(req);
    gravar("fila-envio.json", { fila, pos, resultado, salvaEm: new Date().toISOString() });
    return { ok: true };
  },
  "POST /api/ia-lotes": async (req) => {
    const b = await corpo(req);
    if (b.perfil) {
      estado.config.perfil = b.perfil;
      gravar("config.json", estado.config);
    }
    if (estado.interesseLote?.rodando) throw new Error("o \"Captar e enviar\" está rodando — pare ele antes");
    // a análise do início (só analisa) dá lugar ao Iniciar, que analisa E envia
    if (estado.iaLote?.rodando && estado.iaLote.enviar === false) {
      estado.iaLote.parar = true;
      while (estado.iaLote?.rodando) await new Promise((ok) => setTimeout(ok, 1000));
    }
    iaEmLotes({ tamanho: b.tamanho, notaMin: b.notaMin, min: Number(b.min) || 20, max: Number(b.max) || 50, perfil: b.perfil })
      .catch((e) => console.log(`IA em lotes: ${e.message}`));
    return { ok: true };
  },
  "POST /api/ia-parar": async () => {
    if (estado.iaLote) {
      estado.iaLote.parar = true;
      if (estado.iaLote.rodando) estado.iaLote.atual = "parando… (termina o projeto atual)";
      gravar("lote-ia.json", estado.iaLote);
    }
    return { ok: true };
  },
  "POST /api/interesse-todos": async (req) => {
    const b = await corpo(req);
    // IA em lotes rodando: para ela (termina o projeto atual) e começa logo depois
    const ia = estado.iaLote;
    if (ia?.rodando) {
      ia.parar = true;
      ia.atual = "parando pra dar lugar ao Captar e enviar…";
      gravar("lote-ia.json", ia);
    }
    (async () => {
      while (estado.iaLote?.rodando) await new Promise((ok) => setTimeout(ok, 1000));
      await interesseEmTodos({ mensagem: b.mensagem, min: Number(b.min) || 15, max: Number(b.max) || 40, escanear: b.escanear !== false, paginas: Number(b.paginas) || 0, abas: Number(b.abas) || 4 });
    })().catch((e) => console.log(`Captar e enviar: ${e.message}`));
    return { ok: true, esperandoIA: !!ia?.rodando };
  },
  "POST /api/interesse-parar": async () => {
    if (estado.interesseLote) {
    estado.interesseLote.parar = true;
    if (estado.interesseLote.rodando) estado.interesseLote.atual = "parando… (cada aba termina o projeto que está enviando)";
    gravar("lote-interesse.json", estado.interesseLote); // parado de propósito: não retoma no reinício
  }
    return { ok: true };
  },
  "POST /api/interesse": async (req) => {
    const { id, mensagem } = await corpo(req);
    return enviarInteresse(id, mensagem);
  },
};

// rede de segurança: promise solta com erro não derruba o painel inteiro
process.on("unhandledRejection", (e) => console.log(`erro solto: ${e?.message ?? e}`));

createServer(async (req, res) => {
  const rota = rotas[`${req.method} ${new URL(req.url, "http://x").pathname}`];
  if (!rota) return json(res, 404, { erro: "rota inexistente" });
  try {
    const r = await rota(req, res);
    if (r !== undefined) json(res, 200, r);
  } catch (e) {
    json(res, 500, { erro: e.message });
  }
}).listen(PORTA, "127.0.0.1", () => {
  const url = `http://localhost:${PORTA}`;
  const itens = Object.values(estado.indice);
  estado.salvo = { quando: Date.now(), conversas: itens.length, lidas: itens.filter((i) => i.lido).length, comTelefone: itens.filter((i) => i.telefones?.length).length };
  console.log(`painel em ${url}  (salvo em disco: ${estado.salvo.conversas} conversas, ${estado.salvo.comTelefone} com telefone)`);
  if (process.platform === "win32" && !process.env.SEM_ABRIR) exec(`start "" "${url}"`);
  // no início: só o scanner da caixa (traz os contatos liberados pro WhatsApp).
  // Captação de /projetos e IA NÃO rodam mais sozinhas: interesse no site está desligado (ban por spam) —
  // o v1 agora só manda WhatsApp pros contatos que já tem.
  const apagados = limparProjetos();
  if (apagados) console.log(`${apagados} projetos que não têm nada a ver com você saíram da lista`);
  // a lista é filtrada, então não dá pra estimar as páginas pelos projetos: sem total até uma leitura completa
  const pn = estado.projetosNovos;
  if ((pn.totalPaginas ?? 0) < (pn.pagina ?? 0)) pn.totalPaginas = null;
  const incompleto = estado.scan && Object.values(estado.scan.fases).some((v) => v === "rodando");
  rodarScanner({ modo: !Object.keys(estado.indice).length ? "tudo" : incompleto ? "continuar" : "novidades" });
  // lista incompleta: continua da página onde parou; completa: só busca os novos (para quando não aparece nada novo)
  const iaSalvo = ler("lote-ia.json", null);
  if (iaSalvo) estado.iaLote = { ...iaSalvo, rodando: false, atual: "desligado (interesse no site desligado)" };
  const loteSalvo = ler("lote-interesse.json", null);
  if (loteSalvo) estado.interesseLote = { ...loteSalvo, rodando: false, atual: loteSalvo.rodando && !loteSalvo.parar ? "pausado — clique Captar e enviar pra continuar" : loteSalvo.parar ? "parado" : loteSalvo.atual };
});
