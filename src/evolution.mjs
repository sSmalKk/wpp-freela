/**
 * Cliente mínimo da Evolution API (v2), portado de
 * remix-of-addai/src/lib/social/evolution.server.ts.
 */

function base() {
  const url = (process.env.EVOLUTION_API_URL ?? "").replace(/\/+$/, "");
  if (!url) throw new Error("EVOLUTION_API_URL vazio no .env");
  return url;
}

function chave() {
  const k = process.env.EVOLUTION_API_KEY ?? "";
  if (!k) throw new Error("EVOLUTION_API_KEY vazio no .env — cole a chave do SSM /publiva/evolution/apikey");
  return k;
}

export function instancia() {
  return process.env.EVOLUTION_INSTANCE || "freela";
}

async function chamar(caminho, { method = "GET", body } = {}) {
  const res = await fetch(`${base()}${caminho}`, {
    method,
    headers: { apikey: chave(), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const bruto = await res.text();
  let corpo = bruto;
  try {
    corpo = JSON.parse(bruto);
  } catch {
    /* corpo cru */
  }
  return { ok: res.ok, status: res.status, corpo };
}

function falha(etapa, r) {
  const detalhe = typeof r.corpo === "string" ? r.corpo : JSON.stringify(r.corpo);
  return new Error(`Evolution ${etapa}: HTTP ${r.status} ${detalhe.slice(0, 300)}`);
}

/** 5511999998888 a partir de "(11) 99999-8888", "+55 61 ..." etc. */
export function normalizarNumero(entrada) {
  let d = String(entrada).replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (d.length < 12) throw new Error(`número inválido: ${entrada}`);
  return d;
}

/** open → conectado; connecting → aguardando; 404/resto → desconectado. */
export async function estado() {
  const r = await chamar(`/instance/connectionState/${encodeURIComponent(instancia())}`);
  if (r.status === 404) return "inexistente";
  if (!r.ok) throw falha("connectionState", r);
  const s = String(r.corpo?.instance?.state ?? r.corpo?.state ?? "").toLowerCase();
  return s === "open" ? "conectado" : s === "connecting" ? "aguardando" : "desconectado";
}

/** Cria a instância se não existe; "já em uso" conta como sucesso. */
async function garantirInstancia() {
  const r = await chamar("/instance/create", {
    method: "POST",
    body: { instanceName: instancia(), integration: "WHATSAPP-BAILEYS", qrcode: true },
  });
  if (r.ok) return r.corpo;
  const detalhe = JSON.stringify(r.corpo).toLowerCase();
  if ((r.status === 403 || r.status === 409) && detalhe.includes("already in use")) return null;
  throw falha("instance/create", r);
}

function lerPareamento(corpo) {
  const fonte = corpo?.qrcode ?? corpo ?? {};
  const b64 = typeof fonte.base64 === "string" ? fonte.base64 : null;
  const codigo = typeof fonte.pairingCode === "string" ? fonte.pairingCode : null;
  return { qrBase64: b64 ? b64.replace(/^data:[^,]*,/, "") : null, codigo };
}

/** QR (sem número) ou código de 8 caracteres (com número). QR vence em ~40 s. */
export async function conectar(numero) {
  const criada = await garantirInstancia();
  if (!numero) {
    const doCreate = lerPareamento(criada);
    if (doCreate.qrBase64) return doCreate;
  }
  const q = numero ? `?number=${encodeURIComponent(normalizarNumero(numero))}` : "";
  const r = await chamar(`/instance/connect/${encodeURIComponent(instancia())}${q}`);
  if (!r.ok) throw falha("instance/connect", r);
  return lerPareamento(r.corpo);
}

/**
 * Liga o recebimento do histórico antigo (syncFullHistory) e desconecta o aparelho —
 * o histórico só vem no próximo pareamento, então é preciso escanear o QR de novo.
 */
export async function ativarHistoricoCompleto() {
  const atual = await chamar(`/settings/find/${encodeURIComponent(instancia())}`);
  const s = atual.ok && atual.corpo ? atual.corpo : {};
  const r = await chamar(`/settings/set/${encodeURIComponent(instancia())}`, {
    method: "POST",
    body: {
      rejectCall: !!s.rejectCall,
      msgCall: s.msgCall ?? "",
      groupsIgnore: !!s.groupsIgnore,
      alwaysOnline: !!s.alwaysOnline,
      readMessages: !!s.readMessages,
      readStatus: !!s.readStatus,
      syncFullHistory: true,
    },
  });
  if (!r.ok) throw falha("settings/set", r);
  const sair = await chamar(`/instance/logout/${encodeURIComponent(instancia())}`, { method: "DELETE" });
  if (!sair.ok && sair.status !== 404) throw falha("instance/logout", sair);
  return { syncFullHistory: true };
}

/** Número do celular que escaneou o QR. */
export async function numeroConectado() {
  const r = await chamar(`/instance/fetchInstances?instanceName=${encodeURIComponent(instancia())}`);
  if (!r.ok) return null;
  const item = Array.isArray(r.corpo) ? r.corpo[0] : r.corpo;
  const jid = item?.ownerJid ?? item?.owner ?? item?.instance?.owner ?? "";
  const d = String(jid).split("@")[0].split(":")[0].replace(/\D/g, "");
  return d.length >= 10 ? d : null;
}

/** { "5511...": true|false } — quais números têm WhatsApp. */
export async function temWhatsapp(numeros) {
  const lista = [...new Set(numeros.map(normalizarNumero))];
  if (!lista.length) return {};
  const r = await chamar(`/chat/whatsappNumbers/${encodeURIComponent(instancia())}`, {
    method: "POST",
    body: { numbers: lista },
  });
  if (!r.ok) throw falha("chat/whatsappNumbers", r);
  const saida = Object.fromEntries(lista.map((n) => [n, false]));
  for (const item of Array.isArray(r.corpo) ? r.corpo : []) {
    const n = String(item.number ?? item.jid ?? "").split("@")[0].replace(/\D/g, "");
    const alvo = lista.find((x) => x === n || x.endsWith(n.slice(-8)));
    if (alvo) saida[alvo] = !!item.exists;
  }
  return saida;
}

export async function fotoPerfil(numero) {
  const r = await chamar(`/chat/fetchProfilePictureUrl/${encodeURIComponent(instancia())}`, {
    method: "POST",
    body: { number: normalizarNumero(numero) },
  });
  return r.ok ? (r.corpo?.profilePictureUrl ?? null) : null;
}

/** Últimas mensagens trocadas com o número no WhatsApp: [{ deMim, texto, quando }]. */
export async function historico(numero, limite = 30) {
  const n = normalizarNumero(numero);
  const r = await chamar(`/chat/findMessages/${encodeURIComponent(instancia())}`, {
    method: "POST",
    body: { where: { key: { remoteJid: `${n}@s.whatsapp.net` } }, limit: limite },
  });
  if (!r.ok) return [];
  const lista = r.corpo?.messages?.records ?? r.corpo?.records ?? (Array.isArray(r.corpo) ? r.corpo : []);
  return lista
    .map((m) => ({
      deMim: !!m.key?.fromMe,
      texto:
        m.message?.conversation ??
        m.message?.extendedTextMessage?.text ??
        m.message?.imageMessage?.caption ??
        (m.messageType ? `[${m.messageType}]` : ""),
      quando: m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000).toISOString() : null,
    }))
    .filter((m) => m.texto)
    .sort((a, b) => String(a.quando).localeCompare(String(b.quando)))
    .slice(-limite);
}

/**
 * Chave pra comparar números com o JID do WhatsApp: no Brasil o JID às vezes vem sem o 9
 * do celular (551199998888 × 5511999998888), então compara DDI+DDD + últimos 8 dígitos.
 */
export function chaveNumero(n) {
  const d = String(n).split("@")[0].replace(/\D/g, "");
  return d.startsWith("55") ? `${d.slice(0, 4)}${d.slice(-8)}` : d;
}

/**
 * Quais números já têm conversa no WhatsApp: { numero: { tem, ultima } }.
 * Lê a lista de conversas uma vez; se a Evolution não der, pergunta número a número.
 */
export async function historicoDeConversa(numeros) {
  const saida = {};
  const r = await chamar(`/chat/findChats/${encodeURIComponent(instancia())}`, { method: "POST", body: {} });
  const chats = r.ok ? (Array.isArray(r.corpo) ? r.corpo : (r.corpo?.records ?? r.corpo?.chats ?? [])) : null;
  if (chats) {
    const porChave = {};
    for (const c of chats) {
      let jid = String(c.remoteJid ?? c.id ?? "");
      // formato novo "@lid" esconde o número; o número real às vezes vem na última mensagem
      if (jid.endsWith("@lid")) jid = String(c.lastMessage?.key?.remoteJidAlt ?? c.lastMessage?.key?.senderPn ?? "");
      if (!jid.endsWith("@s.whatsapp.net")) continue; // grupos e @lid sem número
      const quando = c.updatedAt ?? c.lastMessage?.messageTimestamp ?? null;
      porChave[chaveNumero(jid)] = { tem: true, ultima: quando ? new Date(typeof quando === "number" ? quando * 1000 : quando).toISOString() : null };
    }
    for (const n of numeros) saida[n] = porChave[chaveNumero(n)] ?? { tem: false, ultima: null };
    return saida;
  }
  for (let i = 0; i < numeros.length; i += 5) {
    await Promise.all(
      numeros.slice(i, i + 5).map(async (n) => {
        const h = await historico(n, 1).catch(() => []);
        saida[n] = { tem: h.length > 0, ultima: h.at(-1)?.quando ?? null };
      }),
    );
  }
  return saida;
}

/** Quanto histórico a Evolution já tem: conversas, mensagens e as chaves dos números. */
export async function contagemHistorico() {
  const [chats, msgs] = await Promise.all([
    chamar(`/chat/findChats/${encodeURIComponent(instancia())}`, { method: "POST", body: {} }),
    chamar(`/chat/findMessages/${encodeURIComponent(instancia())}`, { method: "POST", body: { limit: 1 } }),
  ]);
  const lista = chats.ok ? (Array.isArray(chats.corpo) ? chats.corpo : (chats.corpo?.records ?? [])) : [];
  const chaves = [];
  for (const c of lista) {
    let jid = String(c.remoteJid ?? "");
    if (jid.endsWith("@lid")) jid = String(c.lastMessage?.key?.remoteJidAlt ?? c.lastMessage?.key?.senderPn ?? "");
    if (jid.endsWith("@s.whatsapp.net")) chaves.push(chaveNumero(jid));
  }
  return { conversas: lista.length, contatos: chaves.length, mensagens: msgs.corpo?.messages?.total ?? null, chaves };
}

export async function enviarTexto(numero, texto) {
  const r = await chamar(`/message/sendText/${encodeURIComponent(instancia())}`, {
    method: "POST",
    body: { number: normalizarNumero(numero), text: texto },
  });
  if (!r.ok) throw falha("message/sendText", r);
  return { id: r.corpo?.key?.id ?? r.corpo?.messageId ?? null };
}
