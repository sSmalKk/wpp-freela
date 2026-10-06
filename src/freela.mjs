/**
 * Lê o freelancer.com.br pela aba logada do Chrome debug.
 *
 * Cada projeto em que você clicou "interesse" vira uma conversa em /account/inbox.
 * (A pasta "Arquivado" do site NÃO é lida — o arquivo é o do painel.) O telefone aparece em:
 *   - mensagem de sistema ("divulgamos agora os dados de contato do empregador")
 *   - mensagens do próprio cliente ("me chama no whats 11 98...")
 * As páginas são buscadas com fetch() de dentro de uma aba só do robô
 * (mesma sessão/Cloudflare) — as suas abas não são tocadas.
 */
import * as cdp from "./cdp.mjs";

const SITE = "https://freelancer.com.br";
const NOME_ABA = "wpp-freela-robo"; // window.name da aba do robô (sobrevive à navegação)

async function abaPropria() {
  for (const t of (await cdp.abas()).filter((t) => t.url.includes("freelancer.com.br"))) {
    const c = await cdp.conectar(t).catch(() => null);
    const nome = await c?.avaliar("window.name").catch(() => "");
    c?.fechar();
    if (nome === NOME_ABA) return t;
  }
  const nova = await (await fetch(`http://localhost:${cdp.porta()}/json/new?${SITE}/account/inbox`, { method: "PUT" })).json();
  const c = await cdp.conectar(nova);
  await cdp.espera(500);
  await c.avaliar(`window.name = "${NOME_ABA}"`).catch(() => {});
  c.fechar();
  return nova;
}

/** Espera a página da aba terminar de carregar (e passar pela Cloudflare). */
async function esperarPagina(c, urlAntes = null) {
  for (let i = 0; i < 60; i++) {
    const t = await c.avaliar("location.href + ' ' + document.readyState + ' ' + (document.body?.innerText.slice(0, 300) ?? '')").catch((e) => {
      if (/aba fechada|conexão com a aba/.test(e.message)) throw e; // aba sumiu: não adianta esperar
      return "";
    });
    const [href, pronto] = t.split(" ");
    if (href?.includes("freelancer.com.br") && href !== urlAntes && pronto === "complete" && !/verificação de segurança/i.test(t)) {
      await cdp.espera(400);
      return;
    }
    await cdp.espera(1000);
  }
  throw new Error("a página do freelancer.com.br não carregou");
}

let avisoLogin = () => {};
/** O servidor registra aqui como avisar "faça login" no painel. */
export function aoPrecisarLogin(fn) {
  avisoLogin = fn;
}

let loginAberto = 0;
async function abrirLoginPraVoce() {
  if (Date.now() - loginAberto < 5 * 60_000) return; // não abre uma aba nova a cada tentativa
  loginAberto = Date.now();
  const aba = await (await fetch(`http://localhost:${cdp.porta()}/json/new?${SITE}/login`, { method: "PUT" })).json();
  await fetch(`http://localhost:${cdp.porta()}/json/activate/${aba.id}`).catch(() => {});
}

export async function abrirSessao() {
  const c = await cdp.conectar(await abaPropria());
  // a aba trabalha em segundo plano: diz ao Chrome pra não congelar/desacelerar
  await c.enviar("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  await c.enviar("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await esperarPagina(c);
  await c.avaliar(`window.name = "${NOME_ABA}"`);
  // logado? pergunta ao próprio site (fetch do inbox com os cookies atuais)
  const estaLogado = () =>
    c.avaliar(`fetch("/account/inbox").then(async (r) => r.url.includes("/account/inbox") && (await r.text()).includes("/account/logout")).catch(() => false)`).catch(() => false);
  if (!(await estaLogado())) {
    // sem sessão: abre o login pra você e espera (até 20 min), sem derrubar o scan
    avisoLogin("faça login no freelancer.com.br na aba que abriu no Chrome — o scanner continua sozinho");
    await abrirLoginPraVoce();
    for (let i = 0; i < 400 && !(await estaLogado()); i++) await cdp.espera(3000);
    if (!(await estaLogado())) {
      c.fechar();
      throw new Error("não está logado no freelancer.com.br — faça login no Chrome (perfil chrome-rpa) e clique Continuar");
    }
    avisoLogin("login ok");
    await c.ir(`${SITE}/account/inbox`);
    await esperarPagina(c);
  }
  return c;
}

/** Roda `fn(arg)` dentro da aba e devolve o resultado (JSON). */
function naAba(c, fn, arg) {
  return c.avaliar(`(${fn.toString()})(${JSON.stringify(arg)})`);
}

/* ---------- código que roda DENTRO da página ---------- */

function paginaCardsAtuais({ arquivada }) {
  return [...document.querySelectorAll(".message-card[data-conversation-id]")]
    .map((card) => {
      const link = card.querySelector('a[href*="/account/inbox/"]');
      if (!link) return null;
      return {
        id: card.dataset.conversationId,
        ultimaMsg: card.dataset.lastMessageId,
        ts: Number(card.dataset.timestamp) || 0,
        url: link.href,
        arquivada,
        cliente: card.querySelector(".person-block .card-title")?.textContent.trim(),
        foto: card.querySelector(".person-block img")?.src ?? null,
        perfil: card.querySelector(".person-block a")?.href,
        assunto: link.querySelector(".card-title")?.textContent.trim(),
        previa: card.querySelector(".message-text")?.textContent.trim(),
      };
    })
    .filter(Boolean);
}

/**
 * FASE 1 — abre a pasta na aba do robô e vai apertando "Próximo" até acabar.
 * `retomarDe`: URL da última página lida (continua dali se a fase caiu no meio).
 * `aoPagina(cards, urlDaPagina, n)` é chamado a cada página — o chamador salva.
 * Com `conhecidas` (id → última mensagem), para na primeira página em que nada mudou.
 */
/* ---------- parar o scanner: conferido a cada página e a cada lote ---------- */
let scannerParado = false;
export function pararScanner(v = true) {
  scannerParado = v;
}
function conferirParada() {
  if (scannerParado) throw new Error("parado por você");
}

async function listarPasta(c, pasta, { retomarDe = null, conhecidas = null, aoPagina = () => {} } = {}) {
  await c.ir(retomarDe || SITE + pasta);
  await esperarPagina(c);
  const arquivada = pasta.includes("archived");
  for (let pagina = 1; pagina <= 300; pagina++) {
    const url = await c.avaliar("location.href");
    const daPagina = await naAba(c, paginaCardsAtuais, { arquivada });
    await aoPagina(daPagina, url, pagina);
    if (conhecidas && daPagina.length && daPagina.every((k) => conhecidas[k.id] === k.ultimaMsg)) return;
    conferirParada();
    const clicou = await c.avaliar(`(() => { const b = document.querySelector("a.pagination-btn.next"); if (!b) return false; b.click(); return true; })()`);
    if (!clicou) return;
    await esperarPagina(c, url);
  }
}

/** Lê os campos da página de um projeto (rodando na página). */
function lerProjetoDoc(d) {
  const meta = {};
  for (const li of d.querySelectorAll(".project-meta-row")) {
    const k = li.querySelector(".project-meta-label")?.textContent.trim();
    if (k) meta[k] = li.querySelector(".project-meta-value")?.textContent.replace(/\s+/g, " ").trim() ?? null;
  }
  const desc = d.querySelector("p.description");
  desc?.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  return {
    titulo: d.querySelector("h1")?.textContent.trim() ?? null,
    orcamento: meta["Orçamento"] ?? null,
    status: meta["Status do projeto"] ?? null,
    postadoEm: meta["Postado em"] ?? null,
    interessados: meta["Interessado"] ?? null,
    descricao: desc?.textContent.trim() ?? "",
    jaInteressado: !d.querySelector("form.interested-form"),
  };
}

/** fetch dentro da página, com 403/429 da Cloudflare virando "CF403". */
function paginaFetcher() {
  const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
  const html = async (u) => {
    for (let t = 0; ; t++) {
      try {
        const r = await fetch(u);
        if (r.status === 403 || r.status === 429) throw new Error("CF403");
        return new DOMParser().parseFromString(await r.text(), "text/html");
      } catch (e) {
        if (e.message === "CF403" || t >= 3) throw e;
        await pausa(2000 * (t + 1));
      }
    }
  };
  return { pausa, html };
}

/** FASE 2 — lê conversas: [{ id, url }] → { id: { conversa, projetoUrl, … } | { erro } }. */
async function paginaLerConversas({ itens, fetcherSrc }) {
  const { pausa, html } = eval(`(${fetcherSrc})`)();
  const cfEmail = (el) => {
    const hex = el.dataset.cfemail;
    if (!hex) return el.textContent;
    const k = parseInt(hex.slice(0, 2), 16);
    let s = "";
    for (let j = 2; j < hex.length; j += 2) s += String.fromCharCode(parseInt(hex.slice(j, j + 2), 16) ^ k);
    return s;
  };
  const saida = {};
  let i = 0;
  async function trabalhador() {
    while (i < itens.length) {
      const { id, url } = itens[i++];
      try {
        const d = await html(url);
        d.querySelectorAll("a.__cf_email__").forEach((a) => a.replaceWith(cfEmail(a)));
        const texto = (b) => {
          const t = b.querySelector(".text");
          if (!t) return "";
          t.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
          return t.textContent.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
        };
        const proj = d.querySelector('a[href*="/projetos/"]');
        // conversa na ordem, com data, pra ler o que o cliente disse em contexto
        let data = "";
        const conversa = [];
        for (const b of d.querySelectorAll(".message-block")) {
          if (b.classList.contains("date")) data = b.textContent.trim();
          else {
            const quem = b.classList.contains("client") ? "cliente" : b.classList.contains("system") ? "site" : "eu";
            conversa.push({ quem, texto: texto(b), data, hora: b.querySelector(".time")?.textContent.trim() ?? "" });
          }
        }
        saida[id] = {
          projetoUrl: proj?.href ?? null,
          projeto: proj?.textContent.trim() || null,
          status: d.querySelector(".project-status .text")?.textContent.trim() ?? null,
          conversa,
          doCliente: conversa.filter((m) => m.quem === "cliente").map((m) => m.texto),
          doSistema: conversa.filter((m) => m.quem === "site").map((m) => m.texto),
        };
      } catch (e) {
        saida[id] = { erro: e.message === "CF403" ? "CF403" : String(e) };
      }
      await pausa(700);
    }
  }
  await Promise.all([1, 2].map(trabalhador)); // devagar: a Cloudflare barra rajadas
  return saida;
}

/** FASE 3 — lê projetos: [{ id: url, url }] → { url: info | { erro } }. */
async function paginaLerProjetos({ itens, fetcherSrc, lerProjetoSrc }) {
  const { pausa, html } = eval(`(${fetcherSrc})`)();
  const lerProjeto = eval(`(${lerProjetoSrc})`);
  const saida = {};
  let i = 0;
  async function trabalhador() {
    while (i < itens.length) {
      const { id, url } = itens[i++];
      try {
        saida[id] = lerProjeto(await html(url));
      } catch (e) {
        saida[id] = { erro: e.message === "CF403" ? "CF403" : String(e) };
      }
      await pausa(700);
    }
  }
  await Promise.all([1, 2].map(trabalhador));
  return saida;
}

async function paginaProjeto({ url, lerProjetoSrc }) {
  const r = await fetch(url);
  if (r.status === 403 || r.status === 429) return { bloqueado: true };
  return eval(`(${lerProjetoSrc})`)(new DOMParser().parseFromString(await r.text(), "text/html"));
}


/* ---------- extração de contato (lado Node) ---------- */

/** Telefones num texto: "+55 19 98253 3081", "11 985275838", "31-999139001", "+351910865272". */
export function telefones(texto) {
  const achados = [];
  for (const m of String(texto).matchAll(/(\+?\d[\d\s().-]{8,18}\d)/g)) {
    const bruto = m[1];
    let d = bruto.replace(/\D/g, "");
    if (bruto.trim().startsWith("+")) {
      if (d.length < 11 || d.length > 15) continue;
    } else if (d.length === 10 || d.length === 11) {
      d = `55${d}`;
    } else if (!(d.length >= 12 && d.length <= 13 && d.startsWith("55"))) {
      continue;
    }
    if (d.startsWith("55") && Number(d.slice(2, 4)) < 11) continue; // DDD inválido
    if (!achados.includes(d)) achados.push(d);
  }
  return achados;
}

function contato(det) {
  const sistema = det.doSistema?.join("\n") ?? "";
  const nome = sistema.match(/Nome do contato:\s*([^\n]+)/)?.[1]?.trim() ?? null;
  const email = sistema.match(/e-mail:\s*([^\s]+@[^\s]+)/i)?.[1] ?? null;
  // projeto postado pelo próprio site ("Freelancer Plataforma", info@freelancer.com.br): o telefone é do site, não de cliente
  const doSite = /@freelancer\.com\.br$/i.test(email ?? "");
  const telSistema = doSite ? [] : telefones(sistema.match(/telefone:\s*([^\n]+)/i)?.[1] ?? "");
  const telCliente = telefones((det.doCliente ?? []).join("\n"));
  const todos = [...new Set([...telCliente, ...telSistema])];
  return { nome, email, telefones: todos, fonte: telCliente.length ? "cliente" : telSistema.length ? "site" : null };
}

/**
 * Roda `fnPagina` em lotes de `itens` ([{ id, url }]) dentro da aba do robô.
 * Itens barrados pela Cloudflare (CF403): abre a página de verdade, espera liberar e repete.
 * `aoLote(resultados, { feitas, total })` a cada lote — o chamador salva, então dá pra retomar.
 */
async function emLotes(fnPagina, itens, extra, aoLote, avisar = () => {}) {
  if (!itens.length) return;
  let c = await abrirSessao();
  const LOTE = 10;
  try {
    for (let k = 0; k < itens.length; k += LOTE) {
      conferirParada();
      const lote = itens.slice(k, k + LOTE);
      const res = {};
      let pendentes = lote;
      for (let tentativa = 0; pendentes.length && tentativa < 5; tentativa++) {
        try {
          Object.assign(res, await naAba(c, fnPagina, { itens: pendentes, fetcherSrc: paginaFetcher.toString(), ...extra }));
          pendentes = pendentes.filter((p) => res[p.id]?.erro === "CF403");
          if (pendentes.length) {
            avisar("Cloudflare pediu verificação, esperando liberar…");
            await cdp.espera(5000 * (tentativa + 1));
            await c.ir(pendentes[0].url);
            await esperarPagina(c);
          }
        } catch (e) {
          if (tentativa >= 4) throw e;
          c.fechar();
          await cdp.espera(3000);
          c = await abrirSessao(); // aba fechada/travada → reabre e repete o lote
        }
      }
      await aoLote(res, { feitas: Math.min(k + LOTE, itens.length), total: itens.length });
    }
  } finally {
    c.fechar();
  }
}

/** FASE 1: lista as pastas. `estado.pastas[pasta] = { url, fim }` diz de onde retomar. */
export async function faseListar(estado, { conhecidas = null, aoPagina, avisar = () => {} }) {
  const c = await abrirSessao();
  try {
    for (const pasta of ["/account/inbox"]) { // só a caixa de mensagens do site
      const st = (estado.pastas[pasta] ??= { url: null, fim: false });
      if (st.fim) continue;
      const nome = pasta.includes("archived") ? "arquivadas" : "mensagens";
      await listarPasta(c, pasta, {
        retomarDe: st.url,
        conhecidas,
        aoPagina: async (cards, url, pagina) => {
          st.url = url;
          avisar(`${nome}: página ${pagina}${st.retomada ? " (retomado)" : ""}`);
          await aoPagina(cards, pasta);
        },
      });
      st.fim = true;
      await aoPagina([], pasta);
    }
  } finally {
    c.fechar();
  }
}

/** FASE 2: lê as conversas pendentes ([{ id, url }]). */
export const faseConversas = (pendentes, aoLote, avisar) => emLotes(paginaLerConversas, pendentes, {}, aoLote, avisar);

/** FASE 3: lê os projetos pendentes ([url]). */
export const faseProjetos = (urls, aoLote, avisar) =>
  emLotes(paginaLerProjetos, urls.map((url) => ({ id: url, url })), { lerProjetoSrc: lerProjetoDoc.toString() }, aoLote, avisar);

/** Card da lista → item do índice. Se a última mensagem mudou, marca pra reler a conversa. */
export function aplicarCard(velho, card) {
  const item = {
    projeto: card.assunto?.match(/`([^`]+)`/)?.[1] || card.assunto,
    situacao: "aguardando",
    telefones: [],
    conversa: [],
    ...(velho ?? {}),
    ...card,
  };
  // itens lidos pela versão antiga não têm lidoMsg: vale a última mensagem que tinham
  const lidoMsg = velho?.lidoMsg ?? (velho?.lido ? velho.ultimaMsg : null);
  item.lido = !!velho?.lido && lidoMsg === card.ultimaMsg;
  item.lidoMsg = lidoMsg;
  return item;
}

/** Junta o item com o que foi lido da conversa. */
export function aplicarConversa(item, det) {
  if (!det || det.erro) return { ...item, erro: det?.erro ?? "sem resposta" };
  const ct = contato(det);
  const telefonesItem = ct.telefones.length ? ct.telefones : (item.telefones ?? []);
  const respondeu = (det.doCliente?.length ?? 0) > 0;
  return {
    ...item,
    projeto: det.projeto || item.projeto,
    projetoUrl: det.projetoUrl ?? item.projetoUrl ?? null,
    status: det.status ?? item.status ?? null,
    conversa: det.conversa,
    respondeu,
    ultimaDoCliente: det.doCliente?.at(-1) ?? null,
    contatoNome: ct.nome ?? item.contatoNome ?? null,
    email: ct.email ?? item.email ?? null,
    telefones: telefonesItem,
    fonteTelefone: ct.fonte ?? item.fonteTelefone ?? null,
    // respondeu = cliente escreveu; liberado = site soltou o contato; aguardando = nenhum dos dois ainda
    situacao: respondeu ? "respondeu" : telefonesItem.length ? "liberado" : "aguardando",
    lido: true,
    lidoMsg: item.ultimaMsg, // lida nesta versão; se a última mensagem mudar, relê
    erro: null,
  };
}

/** Abre `url` numa aba "vitrine" do Chrome e traz ela pra frente (pra você ver a conversa/perfil). */
/**
 * Abre `url` na aba "vitrine" (a mesma sempre, guardada pelo id) e traz pra frente.
 * Não conversa com as outras abas — as do robô ficam ocupadas e travavam o clique — e não espera carregar.
 */
let abaVitrine = null;
export async function mostrarNoChrome(url) {
  const existe = abaVitrine && (await cdp.abas()).find((t) => t.id === abaVitrine);
  if (existe) {
    const c = await cdp.conectar(existe);
    try {
      await c.enviar("Page.navigate", { url }, 10_000);
    } finally {
      c.fechar();
    }
  } else {
    const nova = await (await fetch(`http://localhost:${cdp.porta()}/json/new?${url}`, { method: "PUT" })).json();
    abaVitrine = nova.id;
  }
  await fetch(`http://localhost:${cdp.porta()}/json/activate/${abaVitrine}`).catch(() => {});
}

async function comSessao(fn) {
  const c = await abrirSessao();
  try {
    return await fn(c);
  } finally {
    c.fechar();
  }
}

export const detalheProjeto = (url) =>
  comSessao(async (c) => {
    const r = await naAba(c, paginaProjeto, { url, lerProjetoSrc: lerProjetoDoc.toString() });
    if (!r.bloqueado) return r;
    await c.ir(url); // barrado: abre de verdade e lê a página aberta
    await esperarPagina(c);
    return c.avaliar(`(${lerProjetoDoc})(document)`);
  });

/* ---------- projetos novos: navegando como uma pessoa, numa aba separada do scanner ---------- */

const idDaAba = new Map(); // nome → id da aba (evita varrer todas as abas a cada uso)

/** Aba com `window.name` = nome (cria se não existir). */
async function abaNomeada(nome, url) {
  const abas = await cdp.abas();
  const conhecida = abas.find((t) => t.id === idDaAba.get(nome));
  if (conhecida) return conhecida;
  // aba congelada (Chrome pausou, ou ficou presa de outra conexão) não responde: desiste em 3 s
  const ate3s = (p) => Promise.race([p, new Promise((ok) => setTimeout(() => ok(null), 3000))]);
  for (const t of abas.filter((t) => t.url.includes("freelancer.com.br"))) {
    const c = await ate3s(cdp.conectar(t).catch(() => null));
    const n = c ? await ate3s(c.avaliar("window.name").catch(() => "")) : "";
    c?.fechar();
    if (n === nome) {
      idDaAba.set(nome, t.id);
      return t;
    }
  }
  const nova = await (await fetch(`http://localhost:${cdp.porta()}/json/new?${url}`, { method: "PUT" })).json();
  idDaAba.set(nome, nova.id);
  return nova;
}

const ABA_PROJETOS = "wpp-freela-projetos"; // aba que capta a lista; as de envio são wpp-freela-envio-N

async function sessaoProjetos(nome = ABA_PROJETOS, urlInicial = `${SITE}/projetos`) {
  const aba = await abaNomeada(nome, urlInicial);
  const c = await cdp.conectar(aba);
  c.nome = nome;
  c.abaId = aba.id;
  await c.enviar("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  await c.enviar("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  return c;
}

/** Abre a URL de verdade (passa pela Cloudflare) e marca a aba com o nome dela. */
async function abrir(c, url) {
  await c.ir(url);
  await esperarPagina(c);
  await c.avaliar(`window.name = "${c.nome ?? ABA_PROJETOS}"`).catch(() => {});
}

/** Cards de /projetos na página aberta. */
function paginaCardsProjetos() {
  return [...document.querySelectorAll(".project-list-card[data-id]")].map((c) => {
    const a = c.querySelector("a.assignment-name");
    const sec = (nome) => c.querySelector(`.section-${nome} .content`)?.textContent.replace(/\s+/g, " ").trim() ?? null;
    return {
      id: c.dataset.id,
      titulo: a?.textContent.trim(),
      url: a?.href,
      jaInteressado: c.classList.contains("chatting"),
      quando: sec("active"),
      categoria: sec("category"),
      orcamento: sec("budget"),
      local: sec("location"),
      status: c.querySelector(".project-status .text")?.textContent.trim() ?? null,
      interessados: Number(c.querySelector(".section-status .sub-text")?.textContent.match(/\d+/)?.[0] ?? 0),
    };
  });
}

/**
 * Lê /projetos página a página. `paginas` = 0 → até acabar.
 * `deP` retoma de uma página; `aoPagina(cards, p)` é chamado a cada página (o chamador salva);
 * `parar()` → true interrompe.
 */
export async function listarProjetos(paginas = 5, busca = "", { deP = 1, aoPagina = () => {}, parar = () => false } = {}) {
  const c = await sessaoProjetos();
  try {
    const saida = new Map();
    for (let p = deP; (!paginas || p <= paginas) && !parar(); p++) {
      const q = new URLSearchParams({ page: String(p) });
      if (busca) q.set("q", busca);
      await abrir(c, `${SITE}/projetos?${q}`);
      const cards = await naAba(c, paginaCardsProjetos, {});
      if (!cards.length) break;
      for (const k of cards) if (!saida.has(k.id)) saida.set(k.id, k);
      await aoPagina(cards, p);
      await cdp.espera(1500 + Math.random() * 1500);
    }
    return [...saida.values()];
  } finally {
    c.fechar();
  }
}

/** Estado do botão de interesse na página do projeto aberta. */
function paginaEstadoInteresse() {
  const botoes = [...document.querySelectorAll("button, a.btn")].filter((b) => b.offsetParent !== null);
  const txt = (b) => b.textContent.replace(/\s+/g, " ").trim().toLowerCase();
  if (botoes.some((b) => txt(b).includes("não estou mais interessado"))) return "ja";
  if (botoes.some((b) => txt(b) === "estou interessado")) return "pode";
  return "sem-botao";
}

/**
 * Igual à mão: abre o projeto → "Estou interessado" → escreve a mensagem → "Enviar".
 * Confere no fim se apareceu "não estou mais interessado".
 */
/** `aba`: número da aba de envio (1, 2, 3…) — cada uma trabalha em paralelo. */
export async function enviarInteresse(url, mensagem, { aba = 1 } = {}) {
  // DESLIGADO: a conta levou ban por spam (excesso de interesses) — nem o v1 nem o 2.0 mandam proposta.
  // Só volta se LIBERAR_INTERESSE=1 estiver no .env (depois que o suporte liberar).
  if (process.env.LIBERAR_INTERESSE !== "1") {
    return { ok: false, desligado: true, resposta: "envio de interesse DESLIGADO (conta com ban por spam) — nada foi enviado" };
  }
  // cada projeto numa aba nova (abre vazia, vai direto pro projeto) — fechada no fim
  const c = await sessaoProjetos(`wpp-freela-envio-${aba}`, "about:blank");
  try {
    await abrir(c, url);
    // site fora do ar (Cloudflare 5xx / 522 "Connection timed out"): não é falha do projeto
    const fora = await c.avaliar(`/\\b5\\d\\d\\b|timed out|bad gateway|service unavailable/i.test(document.title)`).catch(() => false);
    if (fora) return { ok: false, temporario: true, resposta: `site fora do ar: ${await c.avaliar("document.title").catch(() => "")}` };
    const antes = await naAba(c, paginaEstadoInteresse, {});
    if (antes === "ja") return { ok: true, jaEstava: true };
    if (antes !== "pode") return { ok: false, resposta: "não achei o botão \"Estou interessado\" (projeto fechado ou sem permissão?)" };

    await c.avaliar(`(() => {
      const b = [...document.querySelectorAll("button, a.btn")].find((x) => x.offsetParent !== null && x.textContent.replace(/\\s+/g, " ").trim().toLowerCase() === "estou interessado");
      b.click();
    })()`);
    // espera o formulário aparecer
    let temForm = false;
    for (let i = 0; i < 20 && !temForm; i++) {
      await cdp.espera(300);
      temForm = await c.avaliar(`!!document.querySelector('form.interested-form textarea[name="message"]')`);
    }
    if (!temForm) return { ok: false, resposta: "o formulário de interesse não abriu" };

    await c.avaliar(`((msg) => {
      const t = document.querySelector('form.interested-form textarea[name="message"]');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      if (msg) { set.call(t, msg); t.dispatchEvent(new Event("input", { bubbles: true })); }
      document.querySelector('form.interested-form button[type="submit"]').click();
    })(${JSON.stringify(mensagem ?? "")})`);

    // confirma: virou "não estou mais interessado"?
    for (let i = 0; i < 30; i++) {
      await cdp.espera(500);
      if ((await naAba(c, paginaEstadoInteresse, {}).catch(() => "")) === "ja") return { ok: true };
    }
    const aviso = await c.avaliar(`[...document.querySelectorAll(".error-msg, .flash-message, .modal, [class*=alert]")].map((e) => e.innerText.trim()).filter(Boolean).join(" | ").slice(0, 300)`).catch(() => "");
    // o site avisou que foi (o botão é que não trocou a tempo)
    if (/interesse do projeto enviado/i.test(aviso)) return { ok: true };
    // última conferência: recarrega o projeto e vê se o botão virou
    await abrir(c, url).catch(() => {});
    if ((await naAba(c, paginaEstadoInteresse, {}).catch(() => "")) === "ja") return { ok: true };
    return { ok: false, resposta: aviso || "o site não confirmou (sem \"não estou mais interessado\" depois de enviar)" };
  } catch (e) {
    // aba fechada / Chrome sem responder: não é falha do projeto — tenta de novo depois
    if (/aba fechada|conexão com a aba|não respondeu|não carregou/.test(e.message)) return { ok: false, temporario: true, resposta: e.message };
    throw e;
  } finally {
    c.fechar();
    // projeto resolvido: fecha a aba dele — no Chrome fica só o que está em andamento
    idDaAba.delete(c.nome);
    await fetch(`http://localhost:${cdp.porta()}/json/close/${c.abaId}`).catch(() => {});
  }
}

/**
 * Lê um projeto abrindo a página de verdade numa aba de análise (a Cloudflare barra o fetch).
 * → { titulo, orcamento, status, descricao, jaInteressado, podeEnviar }
 */
export async function lerProjetoNavegando(url) {
  const c = await sessaoProjetos("wpp-freela-analise", "about:blank");
  try {
    await abrir(c, url);
    const fora = await c.avaliar(`/\b5\d\d\b|timed out|bad gateway|service unavailable/i.test(document.title)`).catch(() => false);
    if (fora) return { temporario: true, erro: `site fora do ar: ${await c.avaliar("document.title").catch(() => "")}` };
    const info = await c.avaliar(`(${lerProjetoDoc})(document)`);
    const estado = await naAba(c, paginaEstadoInteresse, {});
    return { ...info, jaInteressado: estado === "ja", podeEnviar: estado === "pode" };
  } catch (e) {
    if (/aba fechada|conexão com a aba|não respondeu|não carregou/.test(e.message)) return { temporario: true, erro: e.message };
    throw e;
  } finally {
    c.fechar();
  }
}
