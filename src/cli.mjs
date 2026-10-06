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

/** Tabela de quem respondeu no WhatsApp (todos que já receberam msg pelo painel) → também em data/respostas.csv. */
async function respostas() {
  const ler = (f, padrao) => {
    try {
      return JSON.parse(readFileSync(resolve("data", f), "utf8"));
    } catch {
      return padrao;
    }
  };
  if ((await evo.estado().catch(() => "")) !== "conectado") throw new Error("WhatsApp desconectado — conecte (npm run conectar) pra ler as respostas");
  const enviados = ler("enviados.json", {});
  const indice = ler("indice.json", {});
  const linhas = [];
  for (const [id, envios] of Object.entries(enviados)) {
    const ultimo = envios.at(-1);
    if (!ultimo) continue;
    const it = indice[id] ?? {};
    const h = await evo.historico(ultimo.numero, 30).catch(() => []);
    const deles = h.filter((m) => !m.deMim && m.quando && m.quando > ultimo.quando);
    linhas.push({
      cliente: it.cliente ?? "?",
      numero: ultimo.numero,
      projeto: it.projetoInfo?.titulo ?? it.projeto ?? "",
      enviado: ultimo.quando.slice(0, 16).replace("T", " "),
      respondeu: deles.length ? "SIM" : "não",
      resposta: deles.map((m) => m.texto).join(" / ").replace(/\s+/g, " ").slice(0, 200),
    });
  }
  linhas.sort((a, b) => (a.respondeu === b.respondeu ? b.enviado.localeCompare(a.enviado) : a.respondeu === "SIM" ? -1 : 1));
  console.table(linhas.map((l) => ({ ...l, projeto: l.projeto.slice(0, 40), resposta: l.resposta.slice(0, 60) })));
  console.log(`${linhas.filter((l) => l.respondeu === "SIM").length} de ${linhas.length} responderam`);
  const cel = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [Object.keys(linhas[0] ?? { cliente: 0 }), ...linhas.map(Object.values)].map((r) => r.map(cel).join(";")).join("\n");
  writeFileSync(resolve("data", "respostas.csv"), "﻿" + csv);
  console.log("salvo em data/respostas.csv");
}

/** Envia data/lote-whats.json ([{ id, numero, texto }]) pelo painel: espera o WhatsApp conectar, pausa 30-90 s entre um e outro. */
async function lote() {
  const lista = JSON.parse(readFileSync(resolve("data", "lote-whats.json"), "utf8"));
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
  for (let t = 0; (await evo.estado().catch(() => "")) !== "conectado"; t++) {
    if (t >= 180) throw new Error("WhatsApp não conectou em 15 min");
    if (t % 12 === 0) console.log("esperando o WhatsApp conectar…");
    await dorme(5000);
  }
  for (const [k, x] of lista.entries()) {
    const envios = JSON.parse(readFileSync(resolve("data", "enviados.json"), "utf8"))[x.id] ?? [];
    if (envios.some((e) => e.numero === x.numero)) {
      console.log(`${k + 1}/${lista.length} já tinha recebido: ${x.numero}`);
      continue;
    }
    const r = await fetch("http://localhost:3737/api/enviar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: x.id, numero: x.numero, texto: x.texto }),
    });
    const corpo = await r.json().catch(() => ({}));
    console.log(`${k + 1}/${lista.length} ${r.ok ? "enviado" : `ERRO ${corpo.erro}`}: ${x.numero} — ${x.texto}`);
    if (k < lista.length - 1) await dorme(30_000 + Math.random() * 60_000);
  }
}

const comandos = { status, conectar, enviar, respostas, lote };
const fn = comandos[comando];
if (!fn) {
  console.log("comandos: status | conectar [numero] | enviar <numero> <mensagem>");
  process.exit(1);
}
fn().catch((e) => {
  console.error(`erro: ${e.message}`);
  process.exit(1);
});
