/**
 * Cliente mínimo do Chrome DevTools Protocol (Chrome em debug na porta 9222).
 * Node 22+ já tem WebSocket global — sem dependências.
 */

export function porta() {
  return process.env.CHROME_DEBUG_PORT || "9222";
}

async function http(caminho, method = "GET") {
  const res = await fetch(`http://localhost:${porta()}${caminho}`, { method });
  if (!res.ok) throw new Error(`Chrome debug ${caminho}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Chrome do robô fechado (alguém fechou a janela): abre de novo sozinho, com o mesmo perfil do start.bat
 * (já logado no site). Uma vez só por vez, mesmo com várias abas pedindo ao mesmo tempo.
 */
let reabrindo = null;
function reabrirChrome() {
  if (process.platform !== "win32") return Promise.resolve(false);
  reabrindo ??= (async () => {
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const exe = [
      process.env.CHROME_EXE,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ].find((c) => c && existsSync(c));
    if (!exe) return false;
    const perfil = process.env.CHROME_PERFIL || `${process.env.LOCALAPPDATA}\\Publiva\\chrome-rpa`;
    console.log("Chrome do robô estava fechado — abrindo de novo");
    spawn(exe, [`--remote-debugging-port=${porta()}`, `--user-data-dir=${perfil}`, "--no-first-run",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
      "https://freelancer.com.br/projetos"], { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 30; i++) {
      await espera(1000);
      if (await http("/json/version").then(() => true, () => false)) return true;
    }
    return false;
  })().finally(() => setTimeout(() => (reabrindo = null), 30_000));
  return reabrindo;
}

export async function abas() {
  try {
    return (await http("/json/list")).filter((t) => t.type === "page");
  } catch {
    if (await reabrirChrome()) return (await http("/json/list")).filter((t) => t.type === "page");
    throw new Error(`Chrome não está em debug na porta ${porta()} — abra com --remote-debugging-port=${porta()}`);
  }
}

/** Aba cuja URL contém `trecho`; se não houver, abre `urlNova`. */
export async function abaCom(trecho, urlNova) {
  const achada = (await abas()).find((t) => t.url.includes(trecho));
  if (achada) return achada;
  return http(`/json/new?${urlNova}`, "PUT");
}

export async function conectar(aba) {
  const ws = new WebSocket(aba.webSocketDebuggerUrl);
  await new Promise((ok, erro) => {
    ws.onopen = ok;
    ws.onerror = () => erro(new Error("não conectou no WebSocket da aba"));
  });
  let seq = 0;
  const pendentes = new Map();
  let fechada = false;
  // aba fechada (por você ou pelo robô) no meio de um comando: quem esperava recebe erro, não trava
  const encerrar = (motivo) => {
    fechada = true;
    for (const p of pendentes.values()) p.erro(new Error(motivo));
    pendentes.clear();
  };
  ws.onclose = () => encerrar("aba fechada");
  ws.onerror = () => encerrar("conexão com a aba caiu");
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    // "tem certeza que quer sair desta página?" e afins travam a aba: aceita sozinho
    if (msg.method === "Page.javascriptDialogOpening") {
      ws.send(JSON.stringify({ id: ++seq, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
      return;
    }
    const p = pendentes.get(msg.id);
    if (!p) return;
    pendentes.delete(msg.id);
    msg.error ? p.erro(new Error(msg.error.message)) : p.ok(msg.result);
  };
  /** Todo comando tem prazo (padrão 120 s): o Chrome nunca deixa o robô esperando pra sempre. */
  const enviar = (method, params = {}, prazoMs = 120_000) =>
    new Promise((ok, erro) => {
      if (fechada) return erro(new Error("aba fechada"));
      const id = ++seq;
      const timer = setTimeout(() => {
        pendentes.delete(id);
        erro(new Error(`o Chrome não respondeu (${method}) em ${prazoMs / 1000}s`));
      }, prazoMs);
      pendentes.set(id, {
        ok: (v) => (clearTimeout(timer), ok(v)),
        erro: (e) => (clearTimeout(timer), erro(e)),
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await enviar("Page.enable", {}, 10_000).catch(() => {}); // pra receber os avisos de diálogo

  /** Avalia uma expressão (pode ser async) na página e devolve o valor. */
  async function avaliar(expr) {
    const r = await enviar("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async function ir(url) {
    // marca a página velha: sem isso o "complete" dela (ainda na tela) passava por página nova
    // e o robô lia o projeto anterior
    await avaliar("window.__paginaVelha = true").catch(() => {});
    await enviar("Page.navigate", { url });
    for (let i = 0; i < 60; i++) {
      await espera(500);
      const pronto = await avaliar("window.__paginaVelha ? 'velha' : document.readyState").catch((e) => {
        if (fechada) throw e; // aba sumiu: não adianta esperar
        return "";
      });
      if (pronto === "complete") return;
    }
    if ((await avaliar("!!window.__paginaVelha").catch(() => false)) === true) throw new Error(`a página não carregou: ${url}`);
  }

  return { enviar, avaliar, ir, fechar: () => ws.close() };
}

export const espera = (ms) => new Promise((r) => setTimeout(r, ms));
