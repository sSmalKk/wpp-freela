import { writeFileSync } from "node:fs";
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

const comandos = { status, conectar, enviar };
const fn = comandos[comando];
if (!fn) {
  console.log("comandos: status | conectar [numero] | enviar <numero> <mensagem>");
  process.exit(1);
}
fn().catch((e) => {
  console.error(`erro: ${e.message}`);
  process.exit(1);
});
