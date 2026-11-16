// A caixa de entrada fica atrás do seu CLI: só um snapshot completo, com o corpo limitado, pode acordar o Agent de triagem.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

type Sources = {
  folderId: string;
  onlyUnread: boolean;
  lookbackHours: number;
  maxMessages: number;
  bodyChars: number;
  skipSenders: string[];
};
type Summary = {
  message_id: string;
  thread_id?: string;
  subject?: string;
  date_formatted?: string;
  head_from?: { name?: string; mail_address?: string };
  security_level?: { is_risk?: boolean; risk_banner_reason?: string };
};
class AuthorizationError extends Error {}

function lark(args: string[]) {
  // Ler a caixa de entrada é uma decisão humana: o CLI é sempre chamado como o titular, nunca como o bot.
  const run = spawnSync("lark-cli", [...args, "--as", "user"], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const response = JSON.parse(run.status === 0 ? run.stdout : run.stderr);
  if (response.error?.type === "authorization" || response.error?.type === "authentication")
    throw new AuthorizationError();
  if (run.status !== 0 || response.ok !== true)
    throw new Error(
      `Falha ao ler a caixa de entrada: ${response.error?.type ?? "erro desconhecido"}; verifique o CLI nesta máquina`,
    );
  if (response.identity !== "user") throw new Error("A leitura da caixa de entrada não usou a identidade do titular");
  return response.data ?? {};
}

const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
const blockedTitle = "Restabeleça a leitura da caixa de entrada";
if (
  context.answers.length &&
  !context.answers.some(
    (answer: { title: string; choice: number | null }) => answer.title === blockedTitle && answer.choice === 0,
  )
) {
  console.log("NADA A FAZER: a recuperação não foi confirmada nesta rodada; fica para a próxima leitura agendada");
} else if (context.open.some((card: { title: string }) => card.title === blockedTitle) && !context.answers.length) {
  console.log("NADA A FAZER: aguardando o titular restabelecer a leitura da caixa de entrada");
} else {
  const sources: Sources = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (
    !sources.folderId ||
    !Number.isInteger(sources.maxMessages) ||
    sources.maxMessages < 1 ||
    sources.maxMessages > 400 ||
    !Number.isInteger(sources.bodyChars) ||
    sources.bodyChars < 1 ||
    !Number.isInteger(sources.lookbackHours) ||
    sources.lookbackHours < 1 ||
    !Array.isArray(sources.skipSenders)
  ) {
    throw new Error(
      "Verifique o sources.json: defina pasta, horas de retrospectiva, máximo de mensagens e caracteres do corpo",
    );
  }
  try {
    const until = new Date();
    const from = new Date(until.getTime() - sources.lookbackHours * 3_600_000);
    const filter = {
      folder_id: sources.folderId,
      ...(sources.onlyUnread ? { is_unread: true } : {}),
      time_range: { start_time: from.toISOString(), end_time: until.toISOString() },
    };
    // Um remetente ignorado continua ocupando um lugar na página em que chega, então a lista é lida página por página:
    // ler só a primeira deixaria as notificações preencherem o limite e uma caixa com mensagens pareceria vazia.
    const skip = new Set(sources.skipSenders.map((address: string) => address.trim().toLowerCase()));
    const picked: Summary[] = [];
    // Uma requisição devolve no máximo esta quantidade de resumos, seja como for a paginação interna, então paginar
    // além disso não compra nada.
    const ceiling = 400;
    let scanned = 0;
    let pageToken = "";
    let more = true;
    // Mensagens que o titular quer e que o limite deixou fora do snapshot.
    let left = false;
    while (picked.length < sources.maxMessages && more && scanned < ceiling) {
      const listed = lark([
        "mail",
        "+triage",
        "--format",
        "json",
        "--max",
        String(Math.min(sources.maxMessages, ceiling - scanned)),
        "--filter",
        JSON.stringify(filter),
        ...(pageToken ? ["--page-token", pageToken] : []),
      ]);
      if (!Array.isArray(listed.messages))
        throw new Error(
          "A caixa de entrada não devolveu a lista de mensagens; não é o mesmo que não haver mensagens novas",
        );
      const page = listed.messages as Summary[];
      scanned += page.length;
      for (const message of page) {
        if (skip.has((message.head_from?.mail_address ?? "").toLowerCase())) continue;
        if (picked.length < sources.maxMessages) picked.push(message);
        else left = true;
      }
      // Uma página vazia encerra a leitura, seja o que a lista disser sobre haver mais: não resta de onde paginar.
      const next = typeof listed.page_token === "string" ? listed.page_token : "";
      more = listed.has_more === true && next !== "" && page.length > 0;
      pageToken = next;
    }
    // Só é tudo quando a janela foi lida até o fim sem nada ficar de fora; alcançar o limite não diz nada sobre o resto.
    const complete = !more && !left;
    if (!picked.length && complete) {
      console.log(`NADA A FAZER: não há e-mails para ler nas últimas ${sources.lookbackHours} horas`);
    } else {
      // Um remetente que o titular pediu para ignorar não é lido de forma nenhuma, então o corpo dele nunca chega a esta
      // máquina. Uma leitura interrompida sem nada mantido não tem corpos a pedir, e uma lista vazia de ids não é uma
      // requisição que a caixa de entrada aceite.
      const contents = picked.length
        ? lark(["mail", "+messages", "--message-ids", picked.map((m) => m.message_id).join(","), "--html=false"])
        : { messages: [] };
      if (!Array.isArray(contents.messages))
        throw new Error("A caixa de entrada não devolveu o corpo das mensagens; dados incompletos");
      if (Array.isArray(contents.unavailable_message_ids) && contents.unavailable_message_ids.length)
        throw new Error(
          `A caixa de entrada não devolveu o corpo de algumas mensagens (${contents.unavailable_message_ids.length}); nenhuma lista será gerada desta vez`,
        );
      const bodies = new Map<string, { body_plain_text?: string }>(
        (contents.messages as { message_id: string; body_plain_text?: string }[]).map((message) => [
          message.message_id,
          message,
        ]),
      );
      const messages = picked.map((summary) => {
        const body = bodies.get(summary.message_id);
        if (!body)
          throw new Error(
            `A caixa de entrada não devolveu o corpo da mensagem ${summary.message_id}; nenhuma lista será gerada desta vez`,
          );
        const chars = [...(body.body_plain_text ?? "")];
        return {
          message_id: summary.message_id,
          thread_id: summary.thread_id ?? "",
          subject: summary.subject ?? "",
          from: { name: summary.head_from?.name ?? "", address: summary.head_from?.mail_address ?? "" },
          date: summary.date_formatted ?? "",
          risk: {
            is_risk: summary.security_level?.is_risk === true,
            reason: summary.security_level?.risk_banner_reason ?? "",
          },
          body: chars.slice(0, sources.bodyChars).join(""),
          truncated: chars.length > sources.bodyChars,
        };
      });
      const content = {
        from: from.toISOString(),
        until: until.toISOString(),
        folder: sources.folderId,
        limit: sources.maxMessages,
        // O que a listagem conseguiu atravessar, para que a triagem possa dizer se houve mensagens não vistas.
        scanned: { summaries: scanned, complete },
        messages,
      };
      const id = createHash("sha256").update(JSON.stringify(content)).digest("hex");
      writeFileSync("inbox-input.json.tmp", JSON.stringify({ id, ...content }, null, 2), { mode: 0o600 });
      renameSync("inbox-input.json.tmp", "inbox-input.json");
      const receipt = {
        events: [
          {
            id,
            type: "inbox.ready",
            subject: "inbox",
            summary: `A caixa de entrada teve ${messages.length} mensagens lidas neste período${complete ? "" : ", e ainda há mensagens não lidas"}`,
          },
        ],
      };
      console.log(
        `Leitura da caixa de entrada concluída: ${messages.length} mensagens${complete ? "" : " (ainda há mensagens não lidas; a leitura deste período não foi completa)"}\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``,
      );
    }
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    console.log(
      `AGUARDANDO VOCÊ: Restabeleça a leitura da caixa de entrada\n\n\`\`\`agent-autoloop\n${JSON.stringify({
        ask: [
          {
            key: "mail-access",
            title: blockedTitle,
            text: "No computador do worker, entre na caixa de entrada com a identidade do titular ou complete a autorização de leitura e, ao terminar, escolha continuar. Até a recuperação, e-mails antigos não serão usados como o resultado desta leitura.",
            options: ["Já restabeleci, continuar a leitura", "Pular este período"],
            recommend: 0,
            about:
              "Releia uma vez dentro do escopo do sources.json; só entregue ao Agent de triagem depois de ler tudo até o fim.",
          },
        ],
      })}\n\`\`\``,
    );
  }
}
