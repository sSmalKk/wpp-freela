/**
 * Rascunho de mensagem pelo Ollama local. Nunca envia nada — só sugere texto.
 */

function base() {
  return (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
}

export function modelo() {
  return process.env.OLLAMA_MODEL || "llama3.1:8b";
}

/** Modelo da análise de projetos (~25 s por projeto na CPU). */
function modeloAnalise() {
  return process.env.OLLAMA_MODELO_ANALISE || "llama3.1:8b"; // o qwen 3b errava a nota (vídeo = 6)
}

/**
 * GTX 1060 com driver 560: o CUDA desta versão do Ollama quebra ("PTX … unsupported toolchain").
 * Por padrão roda na CPU (num_gpu 0). OLLAMA_GPU=1 no .env volta pra GPU depois de atualizar o driver.
 */
function opcoes(extra) {
  return process.env.OLLAMA_GPU === "1" ? extra : { ...extra, num_gpu: 0 };
}

/** `item` é uma linha do índice; `projeto` vem de freela.detalheProjeto. */
export async function rascunho(item, projeto = {}, jaFalamos = []) {
  const assinatura = process.env.MEU_NOME || "Gustavo";
  const primeiroNome = String(item.contatoNome || item.cliente || "").split(/\s+/)[0];
  const prompt = [
    `Você é ${assinatura}, freelancer brasileiro de tecnologia. Um cliente publicou o projeto abaixo no site`,
    "Freelancer.com.br, você demonstrou interesse lá e agora vai chamá-lo direto no WhatsApp.",
    "Escreva a mensagem de WhatsApp em português do Brasil, tom direto e cordial, no máximo 4 frases curtas:",
    `cumprimente${primeiroNome ? ` ${primeiroNome} pelo primeiro nome` : ""}, diga que viu o projeto no Freelancer.com.br,`,
    "mostre que entendeu o que ele precisa citando 1 detalhe concreto, diga em uma frase como você resolveria",
    'e termine SEMPRE com a frase exata "Podemos falar sobre o projeto?" (logo antes da assinatura).',
    "Sem emojis, sem markdown, sem colchetes ou campos para preencher, sem inventar preço ou prazo.",
    `Assine só com "${assinatura}". Responda apenas com o texto da mensagem.`,
    jaFalamos.length
      ? `IMPORTANTE: você JÁ conversou com esse cliente pelo WhatsApp antes, sobre "${jaFalamos[0].projeto}". ` +
        'Comece em tom de retorno, tipo "Opa, boa tarde! Aqui é o Gustavo de novo", cite o projeto anterior de passagem e depois fale do novo.'
      : "",
    (item.conversa ?? []).some((m) => m.quem === "cliente")
      ? `O que o cliente já te escreveu no site:\n${item.conversa.filter((m) => m.quem === "cliente").map((m) => `- ${m.texto}`).join("\n").slice(0, 800)}`
      : "",
    "",
    `Projeto: ${projeto.titulo || item.projeto}`,
    projeto.orcamento ? `Orçamento: ${projeto.orcamento}` : "",
    projeto.descricao ? `Descrição: ${projeto.descricao.slice(0, 2500)}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const res = await fetch(`${base()}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: modelo(), prompt, stream: false, options: opcoes({ temperature: 0.6 }) }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Ollama: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const { response } = await res.json();
  return String(response ?? "").trim().replace(/^["“]|["”]$/g, "");
}

/**
 * Analisa se um projeto novo encaixa no seu perfil e escreve a mensagem de interesse
 * (vai no próprio site, no botão "Estou interessado"). → { nota 0-10, encaixa, motivo, mensagem }
 */
export async function analisarProjeto(projeto, perfil) {
  const assinatura = process.env.MEU_NOME || "Gustavo";
  const prompt = [
    `Você é o assistente de ${assinatura}, freelancer. Decida se ele deve se candidatar ao projeto abaixo e escreva a candidatura que ${assinatura} vai mandar ao CLIENTE.`,
    "",
    `PERFIL DE ${assinatura.toUpperCase()}:`,
    perfil,
    "",
    "PROJETO (publicado por um cliente no Freelancer.com.br):",
    `Título: ${projeto.titulo}`,
    projeto.categoria ? `Categoria: ${projeto.categoria}` : "",
    projeto.orcamento ? `Orçamento: ${projeto.orcamento}` : "",
    projeto.local ? `Local: ${projeto.local}` : "",
    `Descrição: ${(projeto.descricao || "(sem descrição)").slice(0, 2500)}`,
    "",
    "REGRAS DA NOTA (0 a 10):",
    '- 8 a 10: o trabalho é exatamente do tipo que está em "Faz" no perfil;',
    "- 5 a 7: tem relação parcial (uma parte técnica que ele faz);",
    '- 0 a 2: é algo de "Não faz" (vídeo, design gráfico, vendas, atendimento, redação, tradução, vaga presencial/CLT) ou de outra área.',
    "",
    "Responda SÓ um JSON com as chaves:",
    '"nota": inteiro de 0 a 10 seguindo as regras;',
    '"motivo": uma frase curta dizendo por que (cite o que ele faz ou não faz);',
    `"mensagem": a candidatura escrita POR ${assinatura} PARA o cliente, em português do Brasil, 2 a 3 frases, cordial e direta: mostre que entendeu o pedido citando 1 detalhe concreto do projeto, diga em uma frase como resolveria e termine com "Podemos falar sobre o projeto?". Comece com "Olá!" (não chame o cliente de ${assinatura}). Sem emojis, sem colchetes, sem inventar preço ou prazo. Assine "${assinatura}".`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const res = await fetch(`${base()}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: modeloAnalise(), prompt, stream: false, format: "json", options: opcoes({ temperature: 0.3 }) }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Ollama: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const { response } = await res.json();
  let j;
  try {
    j = JSON.parse(response);
  } catch {
    throw new Error(`Ollama não devolveu JSON: ${String(response).slice(0, 150)}`);
  }
  const nota = Math.max(0, Math.min(10, Math.round(Number(j.nota) || 0)));
  return { nota, motivo: String(j.motivo ?? "").trim(), mensagem: String(j.mensagem ?? "").trim() };
}
