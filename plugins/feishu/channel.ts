// Feishu (Lark), pelo lark-cli oficial: é ele quem guarda as credenciais do aplicativo e a conexão longa que traz os
// cliques de volta, então esta máquina não precisa de endereço público. Só um listener consegue deter os cliques nos
// cartões de um aplicativo, então rode isto num único lugar.
//   "channels": { "feishu": { "key": "…", "user": "ou_xxx" } } no config.json
//   "channels": { "feishu": { "name": "Feishu", "answerers": ["ou_xxx"] } } no rules.json: quem pode responder.
import { execFile, spawn } from "node:child_process";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { eachLine } from "../../host/lines.ts";
import { commandLine } from "../../host/command.ts";

/** O Feishu envia estes valores como JSON dentro de uma string, que pode estar vazia. */
function safeJson(text: unknown): any {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function outcomeOf(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  if (card.state === "decided") return `Você escolheu ${chosen}. Registrado, aguardando tratamento.`;
  if (card.state === "done")
    return `Você escolheu ${chosen}. ${card.result ? `Executado: ${card.result}` : "Executado."}`;
  if (card.state === "closed" && card.kind === "ask") return `Não precisa mais decidir: ${card.result ?? ""}`;
  return card.state === "closed" && card.result ? card.result : null;
}

/** Um cartão, como ele está agora: as opções enquanto aberto, o que foi feito dele depois. */
export function render(card: Card) {
  const outcome = outcomeOf(card);
  // Cada opção é um bloco que atravessa o cartão, com o texto quebrando: botões lado a lado, de uma linha de altura,
  // cortam opções longas.
  const option = (label: string, index: number) => ({
    tag: "interactive_container",
    width: "fill",
    has_border: true,
    border_color: index === card.recommend ? "blue" : "grey",
    corner_radius: "8px",
    padding: "8px 12px 8px 12px",
    behaviors: [{ type: "callback", value: { card: card.id, choice: index } }],
    elements: [{ tag: "div", text: { tag: "plain_text", content: label } }],
  });
  const afterwards = outcome ? [{ tag: "markdown", content: `**${outcome}**` }] : [];
  const noteSaid =
    card.kind === "notice" && card.answer
      ? [{ tag: "div", text: { tag: "plain_text", content: `Nota de tratamento: ${card.answer}` } }]
      : [];
  const notice = card.kind === "notice";
  // Os dois formulários enviam `note`; uma pergunta o usa como resposta, uma notificação o registra ao encerrar o cartão.
  const textForm = [
    {
      tag: "form",
      name: notice ? "handling_note" : `ask_text_${card.id}`,
      elements: [
        {
          tag: "input",
          name: "note",
          input_type: "multiline_text",
          rows: 2,
          auto_resize: true,
          max_length: 1000,
          label: {
            tag: "plain_text",
            content: notice ? "Nota de tratamento (opcional)" : "Nenhuma opção serve? Escreva a resposta",
          },
          label_position: "top",
          placeholder: {
            tag: "plain_text",
            content: notice
              ? "Por exemplo: respondi que o vídeo sai na semana que vem; ou: é spam em massa, pode ignorar"
              : 'Escreva e toque em "Enviar texto"; se marcar uma opção depois, o texto não vai junto',
          },
        },
        {
          tag: "button",
          name: notice ? `handling_note_submit_${card.id}` : `ask_text_submit_${card.id}`,
          form_action_type: "submit",
          type: notice ? "primary" : "default",
          text: { tag: "plain_text", content: notice ? "Registrar e encerrar" : "Enviar texto" },
        },
      ],
    },
  ];
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    header: {
      title: { tag: "plain_text", content: card.title },
      // De que regra ou tarefa ele veio, em qualquer estado: cartões de muitos lugares chegam à mesma pessoa.
      ...(card.rule && card.rule !== card.title
        ? { subtitle: { tag: "plain_text", content: `Fonte: ${card.rule}` } }
        : {}),
      template: card.state === "open" ? "blue" : card.state === "closed" ? "grey" : "green",
    },
    body: {
      elements: [
        ...(card.text ? [{ tag: "markdown", content: card.text }] : []),
        ...(card.state === "open"
          ? [...(notice ? textForm : []), ...card.options.map(option), ...(notice ? [] : textForm)]
          : [...afterwards, ...noteSaid]),
      ],
    },
  };
}

export default async function feishu({ hub, options, log, signal }: ChannelContext) {
  const program = (options.lark as string | undefined) ?? "lark-cli";
  const lark = async (args: string[], input?: string) => {
    const printed = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        ...commandLine([program, ...args]),
        { encoding: "utf8", timeout: 60_000, signal },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.on("error", input === undefined ? () => {} : reject);
      child.stdin!.end(input);
    });
    const out = JSON.parse(printed);
    if (out.ok === false || out.error) {
      throw new Error(`lark-cli ${args.slice(0, 3).join(" ")}: ${JSON.stringify(out.error ?? out).slice(0, 300)}`);
    }
    return out;
  };
  const owner = (options.user as string | undefined) ?? (await lark(["auth", "status"], "")).identities?.user?.openId;
  if (!owner) throw new Error("o canal Feishu precisa de user no config.json, ou rode antes lark-cli auth login");

  const updateMessage = (ref: string, content: string) =>
    lark(["im", "messages", "patch", "--message-id", ref, "--as", "bot", "--data", "-"], JSON.stringify({ content }));

  /** Envia o texto do cartão como mensagem nova, ou devolve a que uma tentativa anterior com esta chave já criou. */
  async function sendMessage(key: string, content: string) {
    const target = ["--user-id", owner, "--as", "bot", "--msg-type", "interactive"];
    const once = ["--idempotency-key", key];
    return (await lark(["im", "+messages-send", ...target, ...once, "--content", content])).data.message_id as string;
  }

  async function deliver() {
    while (!signal.aborted) {
      let card: Card | null;
      try {
        ({ card } = await hub.nextCard(50));
      } catch (error) {
        log(`não foi possível alcançar a central: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      if (!card) continue;
      try {
        const content = JSON.stringify(render(card));
        let ref = card.ref;
        if (ref) {
          try {
            await updateMessage(ref, content);
          } catch (error) {
            // O bot pode não ser o autor da mensagem que lhe mandam alterar, e o Feishu recusa isso de imediato. Um
            // cartão aberto fica como está: a central só conta respostas na mensagem de que ouviu falar primeiro, cujos
            // botões ainda funcionam.
            if (card.state === "open") throw error;
            // Um já resolvido não tem botões: um segundo cartão é pior do que um só, e um cartão congelado na versão
            // anterior à resposta é pior do que os dois. A chave leva a versão para que uma nova tentativa desta não
            // crie uma terceira mensagem.
            log(`cartão ${card.id}: não foi possível atualizar ${ref} (${error}); enviando de novo`);
            await sendMessage(`agent-autoloop-card-${card.id}-v${card.version}`, content);
          }
          // A chave é só o cartão, não a versão dele: um relatório que se perdeu não pode criar uma segunda mensagem.
        } else ref = await sendMessage(`agent-autoloop-card-${card.id}`, content);
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`cartão ${card.id} não enviado: ${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  /** Só vale o clique do titular no cartão que foi enviado; a central confere os dois. */
  async function clicked(line: string) {
    const event = JSON.parse(line);
    const form = safeJson(event.form_value);
    const value = safeJson(event.action_value);
    // O botão de envio de um formulário não pode carregar valor, então o nome dele guarda o número do cartão.
    const named = /^handling_note_submit_(\d+)$/.exec(String(event.action_name ?? ""));
    const words = /^ask_text_submit_(\d+)$/.exec(String(event.action_name ?? ""));
    const cardId = Number.isInteger(value?.card)
      ? value.card
      : named
        ? Number(named[1])
        : words
          ? Number(words[1])
          : null;
    if (!Number.isInteger(cardId)) return;
    const note = typeof form?.note === "string" ? form.note : undefined;
    const given: { choice?: number; by?: string; ref?: string; text?: string } = {
      by: event.operator_id,
      ref: event.message_id,
    };
    if (words) {
      // O formulário de texto de um cartão de pergunta responde só com o texto; um vazio não é resposta alguma.
      if (!note || !note.trim()) return;
      given.text = note;
    } else {
      // A única opção de uma notificação é que ela foi tratada, então enviar o formulário já a escolhe.
      const choice = Number.isInteger(value?.choice) ? value.choice : form ? 0 : null;
      if (choice === null) return;
      given.choice = choice;
      if (note !== undefined) given.text = note;
    }
    const answer = await hub.answer(cardId, given);
    const how = words ? "texto enviado" : form ? "nota enviada" : "respondido";
    log(`cartão ${cardId}: ${how} por ${event.operator_id}, ${answer.changed ? "contado" : "já encerrado"}`);
  }

  async function listen() {
    while (!signal.aborted) {
      // O stdin continua aberto: o lark-cli encerra um consume sem fim quando o stdin dele fecha.
      const consume = spawn(...commandLine([program, "event", "consume", "card.action.trigger", "--as", "bot"]), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Sem este ouvinte, a central inteira terminaria. Um processo que nunca chegou a iniciar ainda assim fecha, o que
      // o inicia de novo mais abaixo.
      consume.on("error", (error) => log(`o listener de cliques não conseguiu rodar: ${error}`));
      const stop = () => consume.kill();
      signal.addEventListener("abort", stop);
      eachLine(consume.stderr, log);
      eachLine(consume.stdout, (line) => void clicked(line).catch((error) => log(`clique não tratado: ${error}`)));
      await new Promise((resolve) => consume.on("close", resolve));
      signal.removeEventListener("abort", stop);
      if (!signal.aborted) {
        log("o listener de cliques parou; iniciando de novo em 10 segundos");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  }

  await Promise.all([deliver(), listen()]);
}
