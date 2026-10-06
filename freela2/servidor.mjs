/**
 * freela 2.0 — tudo num fluxo só, em 5 etapas:
 *   1 Capturar      lê /projetos e a descrição inteira de cada projeto novo
 *   2 Selecionar    a LLM (Ollama) lê o projeto todo e sugere vai / não vai — você confirma clicando
 *   3 Interesse     manda "Estou interessado" nos que estão em "vai" (com limite por dia)
 *   4 Esperar       lê a caixa de mensagens do site até o cliente responder ou o site liberar o contato
 *   5 WhatsApp      manda a 1ª mensagem pela Evolution, sem repetir projeto já conversado
 * Dados próprios em data/v2/; índice de conversas, interesses e enviados são os mesmos do v1.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import * as freela from "../src/freela.mjs";
import * as evo from "../src/evolution.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const DADOS = resolve(AQUI, "..", "data");
const V2 = resolve(DADOS, "v2");
mkdirSync(V2, { recursive: true });
const PORTA = Number(process.env.PORTA || 3737);

function ler(arquivo, padrao) {
  try {
    return JSON.parse(readFileSync(arquivo, "utf8"));
  } catch {
    return padrao;
  }
}
function gravar(arquivo, valor) {
  writeFileSync(`${arquivo}.tmp`, JSON.stringify(valor, null, 1));
  if (existsSync(arquivo)) copyFileSync(arquivo, `${arquivo}.bak`);
  renameSync(`${arquivo}.tmp`, arquivo);
}
const arq = {
  projetos: resolve(V2, "projetos.json"), // id → { titulo, url, categoria, orcamento, local, status, descricao, llm, decisao, ... }
  config: resolve(V2, "config.json"),
  indice: resolve(DADOS, "indice.json"), // conversas do site (mesmo do v1)
  scan: resolve(DADOS, "scan.json"),
  interesses: resolve(DADOS, "interesses.json"), // projetoId → { quando, ok } (mesmo do v1)
  enviados: resolve(DADOS, "enviados.json"), // conversaId → [{ numero, texto, quando }] (mesmo do v1)
};

const CONFIG_PADRAO = {
  perfil: ler(resolve(DADOS, "config.json"), {}).perfil ||
    "Desenvolvedor full-stack freelancer (remoto). Faz: sites, sistemas web, apps, automações, robôs, integrações de API, bots de WhatsApp, IA, dashboards.",
  msgInteresse: ler(resolve(DADOS, "config.json"), {}).msgInteresse ||
    "Oi, Empregador,\n\nEu gostaria de entrar em contato com você a respeito deste projeto.\n\nAtenciosamente,\nGustavo",
  msgWhats: "{saudacao}, {nome}! Eu vim do site de freelancers sobre o projeto \"{projeto}\", vamos conversar sobre?",
  limiteInteresseDia: 40, // o site bloqueou a conta depois de 675 num dia
  pausaMin: 25,
  pausaMax: 70,
  paginas: 10,
};

const estado = {
  projetos: ler(arq.projetos, {}),
  config: { ...CONFIG_PADRAO, ...ler(arq.config, {}) },
  tarefa: null, // { nome, msg, feitas, total, parar } — uma por vez (todas usam o Chrome do robô)
  llm: null, // { rodando, feitas, total, atual, parar }
  ultimoErro: null,
};
const salvarProjetos = () => gravar(arq.projetos, estado.projetos);

/* ---------------- regras rápidas (antes da LLM) ---------------- */

const sem = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const AREAS_MINHAS = /^(Softwares e sistemas|Site e aplicativos|Tecnologia e Ciência)/;
const TITULO_MEU =
  /\bsites?\b|landing|sistema|\bapps?\b|aplicativo|automa[çt]|\brob[oô]s?\b|\bbots?\b|chat ?bot|\bapis?\b|integra[çc][ãa]o|scrap|extra[çt]|dashboard|\bgpt|agentes? de ia|programa[çd]|software|wordpress|e-?commerce|loja virtual|n8n|python|javascript|typescript|node|react|flutter|php|laravel|banco de dados|planilha|excel|crm\b|erp\b|power ?bi|\bweb\b|full ?stack|front-?end|back-?end|desenvolvedor/i;
/** Corte barato: só vai pra LLM o que tem chance. Devolve o motivo do "não" ou null. */
function regraNao(p) {
  if (p.local && !/remot/i.test(p.local)) return "presencial";
  if (/fechad|cancelad|conclu/i.test(p.status ?? "")) return "projeto fechado";
  if (!AREAS_MINHAS.test(p.categoria ?? "") && !TITULO_MEU.test(p.titulo ?? "")) return `área fora do perfil (${p.categoria ?? "?"})`;
  return null;
}

/* ---------------- 1 · capturar ---------------- */

async function capturar(paginas) {
  const t = estado.tarefa;
  let semNovos = 0;
  const interesses = ler(arq.interesses, {});
  await freela.listarProjetos(paginas, "", {
    parar: () => t.parar || semNovos >= 3, // os novos aparecem no começo: 3 páginas sem nada novo = acabou
    aoPagina: (cards, pagina) => {
      let novos = 0;
      for (const k of cards) {
        const velho = estado.projetos[k.id];
        if (!velho) novos++;
        estado.projetos[k.id] = {
          ...velho,
          ...k,
          jaInteressado: k.jaInteressado || !!velho?.jaInteressado || !!interesses[k.id]?.ok,
          capturadoEm: velho?.capturadoEm ?? new Date().toISOString(),
        };
      }
      semNovos = novos ? 0 : semNovos + 1;
      t.msg = `página ${pagina}: ${novos} novos`;
      t.feitas = pagina;
      salvarProjetos();
    },
  });
  // descrição inteira dos que ainda não têm (fetch dentro da aba logada, rápido)
  const faltam = Object.values(estado.projetos).filter((p) => p.descricao == null && !regraNao(p));
  for (const p of Object.values(estado.projetos)) {
    const r = p.descricao == null && regraNao(p);
    if (r && !p.llm) p.llm = { vai: false, motivo: `regra: ${r}`, regra: true };
  }
  salvarProjetos();
  if (t.parar) return;
  t.total = faltam.length;
  t.feitas = 0;
  t.msg = `lendo ${faltam.length} projetos…`;
  const porUrl = Object.fromEntries(faltam.map((p) => [p.url, p]));
  freela.pararScanner(false);
  await freela.faseProjetos(faltam.map((p) => p.url), async (res, prog) => {
    for (const [url, info] of Object.entries(res)) {
      const p = porUrl[url];
      if (!p || info.erro) continue;
      Object.assign(p, { descricao: info.descricao ?? "", status: info.status ?? p.status, orcamento: info.orcamento ?? p.orcamento });
      if (info.jaInteressado) p.jaInteressado = true;
    }
    t.feitas = prog.feitas;
    t.msg = `lendo projetos ${prog.feitas}/${prog.total}`;
    salvarProjetos();
    if (t.parar) freela.pararScanner(true);
  });
  rodarLlm(); // seleção começa sozinha (só sugere — quem decide é você)
}

/* ---------------- 2 · selecionar (LLM) ---------------- */

const OLLAMA = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
const MODELO = process.env.OLLAMA_MODELO_ANALISE || process.env.OLLAMA_MODEL || "llama3.1:8b";

async function perguntarLlm(p) {
  const prompt = [
    "Você faz a triagem de projetos publicados no site Freelancer.com.br para um freelancer.",
    "Leia o projeto INTEIRO e decida se ele deve mandar proposta.",
    "",
    `PERFIL DO FREELANCER: ${estado.config.perfil}`,
    "",
    "NÃO VAI (vai = false) quando for qualquer um destes:",
    "- alguém OFERECENDO ou VENDENDO os próprios serviços, produtos, cursos ou um projeto/sistema pronto (não é um cliente contratando);",
    "- vaga de emprego: CLT, salário, benefícios, presencial, carteira assinada, intermitente, comissão, 'envie currículo';",
    "- trabalho fora do perfil: vídeo, design gráfico, logo, redação, tradução, vendas, atendimento, jurídico, contábil, engenharia, aulas;",
    "- pedido sem sentido, spam, golpe, conteúdo adulto, trabalho acadêmico para entregar como se fosse do aluno.",
    "VAI (vai = true) quando um cliente quer CONTRATAR alguém para fazer algo que está no perfil.",
    "",
    `Título: ${p.titulo}`,
    `Categoria: ${p.categoria ?? ""}`,
    `Orçamento: ${p.orcamento ?? ""}`,
    `Local: ${p.local ?? ""}`,
    `Descrição completa:\n${String(p.descricao || "(sem descrição)").slice(0, 4000)}`,
    "",
    'Responda SÓ um JSON: {"vai": true|false, "motivo": "uma frase curta explicando"}',
  ].join("\n");
  const r = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODELO, prompt, stream: false, format: "json",
      options: { temperature: 0.1, ...(process.env.OLLAMA_GPU === "1" ? {} : { num_gpu: 0 }) },
    }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
  const j = JSON.parse((await r.json()).response);
  return { vai: j.vai === true || j.vai === "true", motivo: String(j.motivo ?? "").trim() };
}

async function rodarLlm() {
  if (estado.llm?.rodando) return;
  const fila = () => Object.values(estado.projetos).filter((p) => !p.llm && p.descricao != null && !p.jaInteressado);
  const l = (estado.llm = { rodando: true, feitas: 0, total: fila().length, atual: "", parar: false, erro: null });
  try {
    for (let p = fila()[0]; p && !l.parar; p = fila()[0]) {
      l.atual = p.titulo;
      l.total = l.feitas + fila().length;
      try {
        p.llm = { ...(await perguntarLlm(p)), quando: new Date().toISOString() };
      } catch (e) {
        l.erro = e.message;
        if (/fetch failed|ECONNREFUSED/.test(e.message)) break; // Ollama fora do ar
        p.llm = { vai: false, motivo: `erro na LLM: ${e.message}`, erro: true };
      }
      l.feitas++;
      salvarProjetos();
    }
  } finally {
    l.rodando = false;
    l.atual = l.parar ? "parado" : l.erro ? `parou: ${l.erro}` : "terminado";
  }
}

/** vai = decisão sua; se você não mexeu, vale a sugestão da LLM. */
const vai = (p) => (p.decisao ? p.decisao === "vai" : !!p.llm?.vai);

/* ---------------- 3 · interesse ---------------- */

function interessesHoje() {
  const hoje = new Date().toDateString();
  return Object.values(ler(arq.interesses, {})).filter((x) => x.ok && new Date(x.quando).toDateString() === hoje).length;
}

const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function pausa(t, rotulo) {
  const { pausaMin: a, pausaMax: b } = estado.config;
  for (let s = Math.round(a + Math.random() * Math.max(0, b - a)); s > 0 && !t.parar; s--) {
    t.msg = `${rotulo} em ${s}s`;
    await dorme(1000);
  }
}

const aEnviarInteresse = () =>
  Object.values(estado.projetos).filter((p) => vai(p) && (p.decisao === "vai" || p.llm) && !p.jaInteressado && !p.interesse?.ok && !p.interesse?.semBotao);

async function mandarInteresses() {
  const t = estado.tarefa;
  const fila = aEnviarInteresse();
  t.total = fila.length;
  for (const [k, p] of fila.entries()) {
    if (t.parar) break;
    const limite = Number(estado.config.limiteInteresseDia) || 40;
    if (interessesHoje() >= limite) {
      t.msg = `limite do dia (${limite}) atingido — o resto fica pra amanhã`;
      return;
    }
    t.msg = `${k + 1}/${fila.length}: ${p.titulo}`;
    const r = await freela.enviarInteresse(p.url, estado.config.msgInteresse, { aba: 1 }).catch((e) => ({ ok: false, resposta: e.message }));
    if (!r.ok && /não é permitido/i.test(r.resposta ?? "")) {
      t.msg = 'o site está bloqueando os envios ("não é permitido") — parei, nada foi perdido';
      return;
    }
    const semBotao = !r.ok && /não achei o botão/.test(r.resposta ?? "");
    p.interesse = { quando: new Date().toISOString(), ok: r.ok, semBotao, resposta: r.ok ? null : r.resposta };
    if (r.ok) p.jaInteressado = true;
    const interesses = ler(arq.interesses, {});
    interesses[p.id] = { quando: p.interesse.quando, ok: r.ok, jaEstava: !!r.jaEstava, semBotao, titulo: p.titulo, url: p.url, v2: true };
    gravar(arq.interesses, interesses);
    salvarProjetos();
    t.feitas = k + 1;
    if (r.ok && !r.jaEstava && k < fila.length - 1) await pausa(t, "próximo");
  }
  t.msg = t.parar ? "parado" : "terminado";
}

/* ---------------- 4 · esperar (caixa de mensagens do site) ---------------- */

const chaveProjeto = (url) => String(url ?? "").split("?")[0].replace(/\/+$/, "").split("/").pop();
const doSite = (i) => /@freelancer\.com\.br$/i.test(i.email ?? "") || /freelancer plataforma/i.test(i.cliente ?? "") || (i.telefones ?? []).includes("551131970269");

async function lerCaixa() {
  const t = estado.tarefa;
  const indice = ler(arq.indice, {});
  const scan = { modo: "novidades", pastas: {} };
  const conhecidas = Object.fromEntries(Object.values(indice).filter((i) => i.lido).map((i) => [i.id, i.lidoMsg ?? i.ultimaMsg]));
  freela.pararScanner(false);
  await freela.faseListar(scan, {
    conhecidas,
    avisar: (m) => (t.msg = m),
    aoPagina: async (cards) => {
      for (const c of cards) indice[c.id] = freela.aplicarCard(indice[c.id], c);
      gravar(arq.indice, indice);
    },
  });
  const pend = Object.values(indice).filter((i) => !i.lido && i.url);
  t.total = pend.length;
  await freela.faseConversas(pend.map((i) => ({ id: i.id, url: i.url })), async (res, prog) => {
    for (const [id, det] of Object.entries(res)) indice[id] = freela.aplicarConversa(indice[id], det);
    t.feitas = prog.feitas;
    t.msg = `conversas ${prog.feitas}/${prog.total}`;
    gravar(arq.indice, indice);
    if (t.parar) freela.pararScanner(true);
  }, (m) => (t.msg = m));
  t.msg = "caixa lida";
}

/** Conversas do site ligadas aos projetos que mandei interesse (pelo v2), ou todas com `todas`. */
function conversas({ todas = false } = {}) {
  const indice = ler(arq.indice, {});
  const enviados = ler(arq.enviados, {});
  const porChave = Object.fromEntries(Object.values(estado.projetos).map((p) => [chaveProjeto(p.url), p]));
  const lista = [];
  for (const i of Object.values(indice)) {
    if (doSite(i)) continue;
    const p = porChave[chaveProjeto(i.projetoUrl)];
    if (!todas && !p?.jaInteressado) continue;
    if (p && !vai(p)) continue; // projeto que você tirou da lista
    lista.push({
      id: i.id,
      cliente: i.contatoNome || i.cliente,
      projeto: i.projetoInfo?.titulo || i.projeto,
      projetoUrl: i.projetoUrl,
      situacao: i.situacao,
      telefones: i.telefones ?? [],
      ultimaDoCliente: i.ultimaDoCliente ?? null,
      enviados: enviados[i.id] ?? [],
      v2: !!p,
      ts: i.ts ?? 0,
    });
  }
  return lista.sort((a, b) => b.ts - a.ts);
}

/* ---------------- 5 · WhatsApp ---------------- */

const VAZIAS = new Set("para com sobre projeto preciso precisa criacao desenvolvimento desenvolver fazer novo nova pequeno simples quero empresa".split(" "));
const palavras = (t) => [...new Set(sem(t).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !VAZIAS.has(w)))];
function falaDoProjeto(texto, titulo) {
  const t = sem(texto);
  if (!titulo || !t) return false;
  if (t.includes(sem(titulo).trim())) return true;
  const ps = palavras(titulo);
  return ps.length > 0 && ps.filter((w) => t.includes(w)).length >= Math.min(3, Math.ceil(ps.length * 0.6));
}
const saudacao = () => {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
};
function montarMsg(c) {
  const nome = String(c.cliente ?? "").trim().split(/\s+/)[0] ?? "";
  return estado.config.msgWhats
    .replaceAll("{saudacao}", saudacao())
    .replaceAll("{nome}", nome ? nome[0].toUpperCase() + nome.slice(1).toLowerCase() : "")
    .replaceAll("{projeto}", c.projeto ?? "")
    .replace(/,\s*!/, "!");
}
/** Já falei desse projeto com esse número? Olha o que o painel registrou e a conversa inteira no WhatsApp. */
async function jaFalei(numero, titulo, id) {
  const enviados = ler(arq.enviados, {});
  const indice = ler(arq.indice, {});
  const k = evo.chaveNumero(numero);
  for (const [cid, es] of Object.entries(enviados)) {
    const t = indice[cid]?.projetoInfo?.titulo || indice[cid]?.projeto;
    if (es.some((e) => evo.chaveNumero(e.numero) === k) && (cid === id || sem(t) === sem(titulo))) return "já recebeu msg desse projeto";
  }
  const h = await evo.historico(numero, 500).catch(() => []);
  const m = h.find((x) => falaDoProjeto(x.texto, titulo));
  return m ? `já falamos disso no WhatsApp: "${m.texto.slice(0, 60)}"` : null;
}

async function mandarWhats(itens) {
  const t = estado.tarefa;
  if ((await evo.estado()) !== "conectado") throw new Error("WhatsApp desconectado — abra /qr e escaneie");
  t.total = itens.length;
  t.log = [];
  for (const [k, x] of itens.entries()) {
    if (t.parar) break;
    const motivo = await jaFalei(x.numero, x.projeto, x.id);
    if (motivo) {
      t.log.push(`pulado ${x.cliente}: ${motivo}`);
      t.feitas = k + 1;
      continue;
    }
    t.msg = `${k + 1}/${itens.length}: ${x.cliente}`;
    try {
      const destino = evo.normalizarNumero(x.numero);
      const { id: msgId } = await evo.enviarTexto(destino, x.texto.trim());
      const enviados = ler(arq.enviados, {});
      (enviados[x.id] ??= []).push({ numero: destino, texto: x.texto.trim(), quando: new Date().toISOString(), msgId, v2: true });
      gravar(arq.enviados, enviados);
      t.log.push(`enviado ${x.cliente}`);
    } catch (e) {
      t.log.push(`ERRO ${x.cliente}: ${e.message}`);
    }
    t.feitas = k + 1;
    if (k < itens.length - 1) await pausa(t, "próximo");
  }
  t.msg = t.parar ? "parado" : "terminado";
}

/** Quem respondeu no WhatsApp depois da 1ª mensagem (base pro onboarding, depois). */
async function respostas() {
  const lista = conversas({ todas: true }).filter((c) => c.enviados.length);
  const out = {};
  for (const c of lista) {
    const ult = c.enviados.at(-1);
    const h = await evo.historico(ult.numero, 100).catch(() => []);
    const deles = h.filter((m) => !m.deMim && m.quando > c.enviados[0].quando);
    out[c.id] = { respondeu: deles.length > 0, texto: deles.map((m) => m.texto).join(" / ").slice(0, 400) };
  }
  gravar(resolve(V2, "respostas.json"), out);
  return out;
}

/* ---------------- tarefas e rotas ---------------- */

function iniciar(nome, fn) {
  if (estado.tarefa?.rodando) throw new Error(`já está rodando: ${estado.tarefa.nome} — pare antes`);
  const t = (estado.tarefa = { nome, rodando: true, msg: "começando…", feitas: 0, total: null, parar: false, desde: Date.now() });
  fn()
    .catch((e) => {
      t.msg = `erro: ${e.message}`;
      console.log(`${nome}: ${e.message}`);
    })
    .finally(() => {
      t.rodando = false;
      t.fim = Date.now();
    });
  return { ok: true };
}

const corpo = (req) =>
  new Promise((ok, erro) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      try {
        ok(s ? JSON.parse(s) : {});
      } catch (e) {
        erro(e);
      }
    });
  });

function resumoProjetos() {
  const ps = Object.values(estado.projetos);
  return ps
    .filter((p) => !/fechad|cancelad|conclu/i.test(p.status ?? "") || p.jaInteressado)
    .sort((a, b) => String(b.capturadoEm).localeCompare(String(a.capturadoEm)))
    .map((p) => ({
      id: p.id, titulo: p.titulo, url: p.url, categoria: p.categoria, orcamento: p.orcamento, local: p.local, quando: p.quando,
      status: p.status, descricao: p.descricao, llm: p.llm ?? null, decisao: p.decisao ?? null, vai: vai(p),
      jaInteressado: !!p.jaInteressado, interesse: p.interesse ?? null,
    }));
}

const rotas = {
  "GET /": (req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(resolve(AQUI, "painel.html")));
  },
  "GET /api/estado": async () => ({
    config: estado.config,
    tarefa: estado.tarefa,
    llm: estado.llm,
    whatsapp: await evo.estado().catch((e) => `erro: ${e.message}`),
    interessesHoje: interessesHoje(),
    aEnviarInteresse: aEnviarInteresse().length,
    projetos: resumoProjetos(),
  }),
  "GET /api/conversas": async (req) => {
    const todas = new URL(req.url, "http://x").searchParams.get("todas") === "1";
    const rs = ler(resolve(V2, "respostas.json"), {});
    return conversas({ todas }).map((c) => ({ ...c, msg: montarMsg(c), resposta: rs[c.id] ?? null }));
  },
  "POST /api/capturar": async (req) => {
    const { paginas = estado.config.paginas } = await corpo(req);
    return iniciar("capturar", () => capturar(Number(paginas) || 10));
  },
  "POST /api/llm": async (req) => {
    const { parar = false, refazer = false } = await corpo(req);
    if (parar) {
      if (estado.llm) estado.llm.parar = true;
      return { ok: true };
    }
    if (refazer) for (const p of Object.values(estado.projetos)) if (p.llm?.erro) delete p.llm;
    rodarLlm();
    return { ok: true };
  },
  "POST /api/decidir": async (req) => {
    const { id, decisao } = await corpo(req);
    const p = estado.projetos[id];
    if (!p) throw new Error("projeto não encontrado");
    p.decisao = decisao === "vai" || decisao === "nao" ? decisao : null;
    salvarProjetos();
    return { ok: true, vai: vai(p) };
  },
  "POST /api/interesse": async () => iniciar("interesse", mandarInteresses),
  "POST /api/caixa": async () => iniciar("caixa", lerCaixa),
  "POST /api/whats": async (req) => {
    const { itens = [] } = await corpo(req);
    if (!itens.length) throw new Error("nada selecionado");
    return iniciar("whatsapp", () => mandarWhats(itens));
  },
  "POST /api/respostas": async () => respostas(),
  "POST /api/parar": async () => {
    if (estado.tarefa) estado.tarefa.parar = true;
    freela.pararScanner(true);
    return { ok: true };
  },
  "POST /api/config": async (req) => {
    Object.assign(estado.config, await corpo(req));
    gravar(arq.config, estado.config);
    return estado.config;
  },
  // QR do WhatsApp no navegador: recarrega a cada 30 s até conectar
  "GET /qr": async (req, res) => {
    let html;
    try {
      if ((await evo.estado()) === "conectado") html = "<h1>WhatsApp conectado ✓</h1><p>Pode fechar esta aba.</p>";
      else {
        const { qrBase64, codigo } = await evo.conectar();
        html = `<h1>Escaneie no WhatsApp</h1><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p>
          ${qrBase64 ? `<img src="data:image/png;base64,${qrBase64}" width="360" height="360">` : ""}
          ${codigo ? `<p>ou o código: <b>${codigo}</b></p>` : ""}<script>setTimeout(() => location.reload(), 30000)</script>`;
      }
    } catch (e) {
      html = `<h1>Erro</h1><p>${String(e.message).replace(/</g, "&lt;")}</p><script>setTimeout(() => location.reload(), 10000)</script>`;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>WhatsApp QR</title><body style="font-family:sans-serif;text-align:center;padding:40px">${html}</body>`);
  },
};

freela.aoPrecisarLogin((m) => estado.tarefa && (estado.tarefa.msg = m));

createServer(async (req, res) => {
  const rota = rotas[`${req.method} ${new URL(req.url, "http://x").pathname}`];
  const json = (cod, v) => {
    res.writeHead(cod, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(v));
  };
  if (!rota) return json(404, { erro: "rota inexistente" });
  try {
    const r = await rota(req, res);
    if (r !== undefined) json(200, r);
  } catch (e) {
    json(500, { erro: e.message });
  }
}).listen(PORTA, "127.0.0.1", () => {
  const url = `http://localhost:${PORTA}`;
  console.log(`freela 2.0 em ${url} — ${Object.keys(estado.projetos).length} projetos salvos`);
  if (process.platform === "win32" && !process.env.SEM_ABRIR) exec(`start "" "${url}"`);
  // a LLM retoma sozinha o que ficou sem análise (só sugere, não envia nada)
  fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) }).then(() => rodarLlm()).catch(() => {});
});
