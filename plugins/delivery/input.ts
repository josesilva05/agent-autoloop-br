// O que a entrega lê do contexto da central e devolve a ela: a qual assunto um evento se refere, e o recibo.
import type { Delivered } from "./delivery.ts";

export function subjectNumber<E extends { subject: string }>(repo: string, context: { events: E[] }) {
  const subjects = [...new Set(context.events.map((event) => event.subject))];
  const suffix = subjects[0]?.slice(repo.length + 1);
  if (subjects.length !== 1 || !subjects[0].startsWith(`${repo}#`) || !/^[1-9]\d*$/.test(suffix)) {
    throw new Error("Os eventos não apontam para o mesmo assunto do repositório indicado pela regra");
  }
  const number = Number(suffix);
  if (!Number.isSafeInteger(number)) throw new Error("O número do assunto está incorreto");
  return number;
}

export function question(issue: { number: number; title: string; body?: string; html_url: string }) {
  const lines = (issue.body ?? "").replace(/```[\s\S]*?```/g, "").split("\n");
  const text = lines
    .filter((line) => !/\/Users\/|\/home\/|Traceback|^\s+at /.test(line))
    .join("\n")
    .trim();
  return {
    key: `owner-${issue.number}`,
    title: [...issue.title].slice(0, 100).join(""),
    text: [...(text || issue.html_url)].slice(0, 1500).join(""),
    options: ["Resolvido", "Não resolver agora"],
    about: issue.html_url,
  };
}

/** A central lê um recibo até os primeiros três backticks, mesmo dentro de uma string; por isso o que as pessoas escreveram não pode contê-los. */
export const receiptBlock = (receipt: object) =>
  `\`\`\`agent-autoloop\n${JSON.stringify(receipt).replaceAll("`", "\\u0060")}\n\`\`\``;

export function deliveryReceipt(number: number, result: Delivered, attended: boolean) {
  if (!result.findings?.length) return result.summary;
  const text = result.findings.map((finding) => `${finding.title}: ${finding.text}`).join("\n");
  // Deixado como foi escrito, um finding poderia conter um bloco de recibo próprio, e a central agiria sobre ele.
  if (attended) return `${result.summary}\n${text.replaceAll("```", "'''")}`;
  // Um cartão aberto com a mesma chave absorve o novo, então findings sobre um commit novo precisam de uma chave própria.
  const key = `review-${number}-${result.head?.slice(0, 12)}`;
  const notice = { key, title: "Há problemas a corrigir antes da entrega", text: [...text].slice(0, 1500).join("") };
  return `${result.summary}\n${receiptBlock({ notice: [notice] })}`;
}

export function pendingEvents(
  repo: string,
  rows: { number: number; head: string; labelEvent: number; kind: string }[],
) {
  return rows.map(({ number, head, labelEvent, kind }) => ({
    id: `${repo}#${number}:${labelEvent}:${head}`,
    type: `${kind}.labeled`,
    subject: `${repo}#${number}`,
    link: `https://github.com/${repo}/${kind === "pull_request" ? "pull" : "issues"}/${number}`,
  }));
}
