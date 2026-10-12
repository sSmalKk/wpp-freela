import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exec } from "node:child_process";
import * as evo from "./evolution.mjs";

const [comando, ...args] = process.argv.slice(2);

function permitidos() {
  return (process.env.DESTINOS_PERMITIDOS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .map(evo.normalizarNumero);
}

async function status() {
  const e = await evo.estado();
  console.log(`instância ${evo.instancia()}: ${e}`);
  if (e === "conectado") console.log(`número: ${(await evo.numeroConectado()) ?? "?"}`);
}

async function conectar() {
  const numero = args[0];
  if ((await evo.estado()) === "conectado") return status();
  const { qrBase64, codigo } = await evo.conectar(numero);
  if (codigo) {
    console.log(`Código de pareamento: ${codigo}`);
    console.log("WhatsApp → Aparelhos conectados → Conectar aparelho → Conectar com número de telefone.");
  }
  if (qrBase64 && !numero) {
    const arquivo = resolve("qr.png");
    writeFileSync(arquivo, Buffer.from(qrBase64, "base64"));
    console.log(`QR salvo em ${arquivo} — escaneie em WhatsApp → Aparelhos conectados (vence em ~40 s).`);
    if (process.platform === "win32") exec(`start "" "${arquivo}"`);
  }
  if (!codigo && !qrBase64) console.log("A Evolution não devolveu QR nem código; rode de novo.");
  console.log("Depois de escanear: npm run status");
}

async function enviar() {
  const [numero, ...resto] = args;
  const texto = resto.join(" ").trim();
  if (!numero || !texto) throw new Error('uso: npm run enviar -- <numero> "mensagem"');
  const destino = evo.normalizarNumero(numero);
  if (!permitidos().includes(destino)) {
    throw new Error(`${destino} não está em DESTINOS_PERMITIDOS no .env — adicione antes de enviar.`);
  }
  const { id } = await evo.enviarTexto(destino, texto);
  console.log(`enviado para ${destino} (id ${id ?? "?"})`);
}

const lerDados = (f, padrao) => {
  try {
    return JSON.parse(readFileSync(resolve("data", f), "utf8"));
  } catch {
    return padrao;
  }
};
const sem = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const VAZIAS = new Set("para com sobre projeto preciso precisa criacao desenvolvimento desenvolver fazer novo nova pequeno simples quero empresa".split(" "));
const palavras = (t) => [...new Set(sem(t).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !VAZIAS.has(w)))];
/** O texto fala desse projeto? (título inteiro, ou a maior parte das palavras importantes dele) */
function falaDoProjeto(texto, titulo) {
  const t = sem(texto);
  if (!titulo || !t) return false;
  if (t.includes(sem(titulo).trim())) return true;
  const ps = palavras(titulo);
  if (!ps.length) return false;
  const achadas = ps.filter((w) => t.includes(w)).length;
  return achadas >= Math.min(3, Math.ceil(ps.length * 0.6));
}
const quandoBr = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
const tituloDo = (it) => it?.projetoInfo?.titulo ?? it?.projeto ?? "";

/**
 * Tabela de respostas: lê a conversa INTEIRA do WhatsApp de cada número que já recebeu msg pelo painel.
 * Uma linha por número; marca DUPLICADA quando mandei mais de uma msg sobre o mesmo projeto. → data/respostas.csv
 */
async function respostas() {
  if ((await evo.estado().catch(() => "")) !== "conectado") throw new Error("WhatsApp desconectado — conecte (npm run conectar) pra ler as respostas");
  const enviados = lerDados("enviados.json", {});
  const indice = lerDados("indice.json", {});
  const porNumero = new Map(); // chave → { numero, envios: [{ titulo, quando, cliente }] }
  for (const [id, envios] of Object.entries(enviados)) {
    for (const e of envios) {
      const k = evo.chaveNumero(e.numero);
      if (!porNumero.has(k)) porNumero.set(k, { numero: e.numero, envios: [] });
      porNumero.get(k).envios.push({ titulo: tituloDo(indice[id]), quando: e.quando, cliente: indice[id]?.cliente ?? "?" });
    }
  }
  const linhas = [];
  for (const { numero, envios } of porNumero.values()) {
    const h = await evo.historico(numero, 500).catch(() => []);
    const primeiro = envios.map((e) => e.quando).sort()[0];
    const minhas = h.filter((m) => m.deMim);
    const deles = h.filter((m) => !m.deMim && m.quando && m.quando > primeiro);
    const titulos = [...new Set(envios.map((e) => e.titulo).filter(Boolean))];
    // quantas msgs minhas falam de cada projeto (lendo a conversa toda, não só o que o painel registrou)
    const dup = titulos
      .map((t) => [t, Math.max(minhas.filter((m) => falaDoProjeto(m.texto, t)).length, envios.filter((e) => e.titulo === t).length)])
      .filter(([, n]) => n > 1);
    linhas.push({
      cliente: envios[0].cliente,
      numero,
      projetos: titulos.join(" | "),
      enviado: quandoBr(envios.map((e) => e.quando).sort().at(-1)),
      "msgs minhas": minhas.length,
      "msgs dele": h.length - minhas.length,
      respondeu: deles.length ? "SIM" : "não",
      duplicada: dup.length ? dup.map(([t, n]) => `${n}x ${t.slice(0, 30)}`).join(" | ") : "",
      resposta: deles.map((m) => m.texto).join(" / ").replace(/\s+/g, " ").slice(0, 300),
    });
  }
  linhas.sort((a, b) => (a.respondeu === b.respondeu ? 0 : a.respondeu === "SIM" ? -1 : 1));
  console.table(linhas.map((l) => ({ ...l, cliente: l.cliente.slice(0, 22), projetos: l.projetos.slice(0, 35), resposta: l.resposta.slice(0, 50) })));
  console.log(`${linhas.filter((l) => l.respondeu === "SIM").length} de ${linhas.length} responderam · ${linhas.filter((l) => l.duplicada).length} com mensagem duplicada`);
  const cel = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [Object.keys(linhas[0] ?? { cliente: 0 }), ...linhas.map(Object.values)].map((r) => r.map(cel).join(";")).join("\n");
  writeFileSync(resolve("data", "respostas.csv"), "﻿" + csv);
  console.log("salvo em data/respostas.csv");
}

const comandos = { status, conectar, enviar, respostas };
const fn = comandos[comando];
if (!fn) {
  console.log("comandos: status | conectar [numero] | enviar <numero> <mensagem>");
  process.exit(1);
}
fn().catch((e) => {
  console.error(`erro: ${e.message}`);
  process.exit(1);
});
