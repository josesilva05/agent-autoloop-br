// Formatos de mensagem dos fornecedores: os links estão listados no protocol.md para que os campos possam ser
// conferidos contra as APIs a que pertencem.
function wecomMarkdown(text: string) {
  return text.replace(/https?:\/\/[^\s；，。]+/g, (url, offset, source) =>
    source.slice(Math.max(0, offset - 2), offset) === "](" ? url : `[Abrir link](${url})`,
  );
}

export function payload(platform: string, text: string): object {
  if (platform === "discord" && [...text].length > 2000) throw new Error("Discord: cartão acima de 2000 caracteres");
  const markdown = platform === "wecom" ? wecomMarkdown(text) : "";
  if (platform === "wecom" && Buffer.byteLength(markdown) > 2048) throw new Error("WeCom: cartão acima de 2048 bytes");
  switch (platform) {
    case "dingtalk":
      return { msgtype: "text", text: { content: text }, at: { isAtAll: false } };
    case "wecom":
      return { msgtype: "markdown", markdown: { content: markdown } };
    case "slack":
      return { text, mrkdwn: false, unfurl_links: false, unfurl_media: false };
    case "discord":
      return { content: text, allowed_mentions: { parse: [] } };
    default:
      throw new Error(`não existe este modelo de Webhook: ${platform}`);
  }
}

export async function accepted(platform: string, response: Response) {
  if (!response.ok) throw new Error(`respondeu ${response.status}`);
  if (platform === "dingtalk" || platform === "wecom") {
    const result = await response.json();
    if (result.errcode !== 0) throw new Error(`falha no envio: ${result.errmsg ?? result.errcode}`);
  } else if (platform === "slack" && (await response.text()).trim() !== "ok") throw new Error("o Slack não confirmou");
}
