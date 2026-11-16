// O menor canal que existe: qualquer coisa que aceite um POST JSON (um robô de grupo no DingTalk, WeCom, Slack,
// Discord…). Texto e um link, sem botões: combine-o com "links": true no rules.json para que o próprio link consiga
// responder aquele cartão.
//   "channels": { "dingtalk": { "use": "webhook", "key": "…", "url": "https://…",
//                               "body": { "msgtype": "text", "text": { "content": "{text}" } } } }
import { accepted, payload } from "./templates.ts";
import type { Card, ChannelContext } from "../../host/channels.ts";

function fill(template: unknown, text: string): unknown {
  if (typeof template === "string") return template.replaceAll("{text}", () => text);
  if (Array.isArray(template)) return template.map((item) => fill(item, text));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fill(value, text)]));
  }
  return template;
}

// O WeCom desenha suas mensagens como Markdown: um link ou uma etiqueta no que um Agent escreveu seria desenhado, e
// poderia passar um link próprio como se fosse o do cartão. Sósias de largura total mantêm o texto e impedem a marcação;
// endereços soltos ainda viram link.
const asWords = (text: string) => text.replaceAll("](", "］(").replaceAll("<", "＜");

function words(card: Card, platform = "") {
  const rule = card.rule && card.rule !== card.title ? card.rule : "";
  if (platform === "wecom")
    card = { ...card, title: asWords(card.title), text: asWords(card.text), options: card.options.map(asWords) };
  const source = rule ? `Fonte: ${platform === "wecom" ? asWords(rule) : rule}` : "";
  if (
    platform === "wecom" &&
    card.kind === "notice" &&
    card.state === "open" &&
    card.options.length === 1 &&
    card.options[0] === "Resolvido" &&
    card.link
  )
    return [card.title, source, card.text, `[Clique para tratar](${card.link})`].filter(Boolean).join("\n\n");
  const choices = card.options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  const parts = [card.title, source, card.text, ...(card.state === "open" ? [choices, card.link] : [])];
  return parts.filter(Boolean).join("\n\n");
}

export default async function webhook({ hub, options, log, signal }: ChannelContext) {
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
    // Ele não consegue alterar uma mensagem já enviada: uma atualização não tem nada a fazer.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    try {
      const response = await fetch(options.url as string, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          options.platform
            ? payload(String(options.platform), words(card, String(options.platform)))
            : fill(options.body ?? { text: "{text}" }, words(card)),
        ),
        signal: AbortSignal.timeout(30_000),
      });
      await accepted(String(options.platform ?? ""), response);
      await hub.delivered(card.id, card.version, `sent-${card.id}`);
    } catch (error) {
      log(`cartão ${card.id} não enviado: ${error}`);
      await hub.failed(card.id, card.version, String(error)).catch(() => {});
    }
  }
}
